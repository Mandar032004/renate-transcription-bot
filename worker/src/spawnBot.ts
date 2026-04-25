import Docker from "dockerode";
import type { Pool } from "pg";
import pino from "pino";

const log = pino({ name: "worker.spawnBot", level: process.env.LOG_LEVEL ?? "info" });

export interface SpawnBotInput {
  sessionId: string;
  meetUrl: string;
  botAccountId?: string;
  image: string;
  network: string;
  authHostPath: string;
  brainHostPath?: string;
  pg: Pool;
  env: Record<string, string>;
}

export interface SpawnBotResult {
  containerId: string;
}

/**
 * Spawns a per-session bot container via the local Docker daemon.
 * The worker container must have /var/run/docker.sock mounted.
 *
 * Picks (or rotates) a bot_account, marks last_used_at, and mounts the
 * matching auth.json into the bot at /auth/auth.json.
 */
export async function spawnBot(input: SpawnBotInput): Promise<SpawnBotResult> {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });

  const account = await pickBotAccount(input.pg, input.botAccountId);
  if (!account) {
    throw new Error("no bot_account available (all on cooldown?)");
  }

  const name = `renate-bot-${input.sessionId.slice(0, 8)}-${Date.now()}`;
  const hostAuthFile = `${input.authHostPath}/${account.email}.auth.json`;

  const binds = [`${hostAuthFile}:/auth/auth.json:ro`];
  if (input.brainHostPath) {
    binds.push(`${input.brainHostPath}:/brain/brain.docx:ro`);
  }

  log.info(
    {
      sessionId: input.sessionId,
      container: name,
      account: account.email,
      brain: !!input.brainHostPath,
    },
    "docker create"
  );

  const container = await docker.createContainer({
    name,
    Image: input.image,
    Env: Object.entries({
      ...input.env,
      SESSION_ID: input.sessionId,
      MEET_URL: input.meetUrl,
      AUTH_PROFILE: "/auth/auth.json",
    }).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      AutoRemove: false,
      NetworkMode: input.network,
      Binds: binds,
      ShmSize: 2 * 1024 * 1024 * 1024, // 2GB for Chromium
    },
    Labels: {
      "renate.session_id": input.sessionId,
      "renate.bot_account": account.email,
    },
  });

  await container.start();

  // Best-effort: update bot_account.last_used_at.
  await input.pg
    .query(`UPDATE bot_accounts SET last_used_at = now() WHERE id = $1`, [account.id])
    .catch((err) => log.warn({ err }, "bot_account bookkeeping failed"));

  // Update session status to joining (non-fatal if row missing).
  await input.pg
    .query(
      `UPDATE sessions
          SET bot_account_id = $1, status = 'joining', started_at = now()
        WHERE id = $2`,
      [account.id, input.sessionId]
    )
    .catch((err) => log.warn({ err }, "session status update failed"));

  log.info({ sessionId: input.sessionId, containerId: container.id }, "bot started");
  return { containerId: container.id };
}

async function pickBotAccount(
  pg: Pool,
  preferredId?: string
): Promise<{ id: string; email: string; auth_path: string } | null> {
  if (preferredId) {
    const { rows } = await pg.query<{ id: string; email: string; auth_path: string }>(
      `SELECT id, email, auth_path FROM bot_accounts WHERE id = $1`,
      [preferredId]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await pg.query<{ id: string; email: string; auth_path: string }>(
    `SELECT id, email, auth_path
       FROM bot_accounts
      WHERE cooldown_until IS NULL OR cooldown_until < now()
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1`
  );
  return rows[0] ?? null;
}

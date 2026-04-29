import { Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import { spawnBot } from "./spawnBot.js";

const log = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const cfg = loadConfig();
  log.info("worker: boot");

  const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const pg = new Pool({ connectionString: cfg.DATABASE_URL });

  const workers = [
    new Worker(
      "spawn-bot",
      async (job) => {
        const { sessionId, meetUrl, botAccountId } = job.data as {
          sessionId: string;
          meetUrl: string;
          botAccountId?: string;
        };
        const jobLog = log.child({ jobId: job.id, sessionId, queue: "spawn-bot" });
        jobLog.info("start");
        await spawnBot({
          sessionId,
          meetUrl,
          botAccountId,
          image: cfg.BOT_IMAGE,
          network: cfg.BOT_NETWORK,
          authHostPath: cfg.AUTH_HOST_PATH,
          brainHostPath: cfg.BRAIN_HOST_PATH || undefined,
          pg,
          env: {
            REDIS_URL: cfg.REDIS_URL,
            LOG_LEVEL: cfg.LOG_LEVEL,
            // Voice assistant passthrough.
            VA_ENABLED: cfg.VA_ENABLED,
            OPENAI_API_KEY: cfg.OPENAI_API_KEY,
            SARVAM_API_KEY: cfg.SARVAM_API_KEY,
            WAKE_WORD: cfg.WAKE_WORD,
            TTS_LANGUAGE: cfg.TTS_LANGUAGE,
            TTS_SPEAKER: cfg.TTS_SPEAKER,
            TTS_MODEL: cfg.TTS_MODEL,
            TTS_RENATE_PRONUNCIATION: cfg.TTS_RENATE_PRONUNCIATION,
            ...(cfg.VA_STOP_PHRASES ? { VA_STOP_PHRASES: cfg.VA_STOP_PHRASES } : {}),
            ...(cfg.VA_RESUME_PHRASES ? { VA_RESUME_PHRASES: cfg.VA_RESUME_PHRASES } : {}),
            ...(cfg.VA_ANSWER_TEMPERATURE ? { VA_ANSWER_TEMPERATURE: cfg.VA_ANSWER_TEMPERATURE } : {}),
            ...(cfg.VA_USE_PREVIOUS_ANSWER ? { VA_USE_PREVIOUS_ANSWER: cfg.VA_USE_PREVIOUS_ANSWER } : {}),
          },
        });
      },
      { connection, concurrency: 4 }
    ),
  ];

  for (const w of workers) {
    w.on("ready", () => log.info({ queue: w.name }, "worker: ready"));
    w.on("failed", (job, err) =>
      log.error({ queue: w.name, jobId: job?.id, err: err?.message }, "job failed")
    );
    w.on("error", (err) => log.error({ queue: w.name, err }, "worker: error"));
  }

  const shutdown = async (sig: string) => {
    log.info({ sig }, "worker: shutdown");
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    await pg.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error({ err }, "worker: fatal");
  process.exit(1);
});

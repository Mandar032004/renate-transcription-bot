import { Redis } from "ioredis";
import pino from "pino";

const log = pino({ name: "bot.state", level: process.env.LOG_LEVEL ?? "info" });

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export interface HeartbeatHandle {
  stop(): void;
}

export function startHeartbeat(
  redis: Redis,
  sessionId: string,
  opts: { intervalMs: number; ttlSeconds: number }
): HeartbeatHandle {
  const key = `session:${sessionId}:alive`;
  let stopped = false;

  const tick = async () => {
    try {
      await redis.set(key, String(Date.now()), "EX", opts.ttlSeconds);
    } catch (err) {
      log.error({ err, key }, "heartbeat failed");
    }
  };

  void tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, opts.intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      log.info({ key }, "heartbeat stopped");
    },
  };
}

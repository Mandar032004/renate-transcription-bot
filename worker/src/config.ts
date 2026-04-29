import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://redis:6379"),
  BOT_IMAGE: z.string().default("renate-bot:latest"),
  BOT_NETWORK: z.string().default("renate-transcription-bot_renate"),
  AUTH_HOST_PATH: z.string().default("/host-auth"),
  CALL_HARD_TIMEOUT_MIN: z.coerce.number().default(120),
  LOG_LEVEL: z.string().default("info"),

  // --- Voice assistant (passed through to per-session bot container) ---
  VA_ENABLED: z.string().default("false"),
  OPENAI_API_KEY: z.string().default(""),
  SARVAM_API_KEY: z.string().default(""),
  BRAIN_HOST_PATH: z.string().default(""),
  WAKE_WORD: z.string().default("renate"),
  TTS_LANGUAGE: z.string().default("en-IN"),
  TTS_SPEAKER: z.string().default("anushka"),
  TTS_MODEL: z.string().default("bulbul:v2"),
  TTS_RENATE_PRONUNCIATION: z.string().default("Rennate"),
  VA_STOP_PHRASES: z.string().default(""),
  VA_RESUME_PHRASES: z.string().default(""),
  VA_ANSWER_TEMPERATURE: z.string().default(""),
  VA_USE_PREVIOUS_ANSWER: z.string().default(""),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(): WorkerConfig {
  return schema.parse(process.env);
}

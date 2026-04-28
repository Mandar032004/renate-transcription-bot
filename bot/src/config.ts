import { z } from "zod";

const schema = z.object({
  SESSION_ID: z.string().min(1).optional(),
  MEET_URL: z.string().url().optional(),
  AUTH_PROFILE: z.string().default("/auth/auth.json"),
  REDIS_URL: z.string().default("redis://redis:6379"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(10_000),
  HEARTBEAT_TTL_SECONDS: z.coerce.number().default(30),
  CALL_HARD_TIMEOUT_MS: z.coerce.number().default(120 * 60 * 1000),
  DISPLAY_NAME: z.string().default("Renate"),
  LOG_LEVEL: z.string().default("info"),

  // --- Voice assistant (VA) ---
  VA_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_ANSWER_MODEL: z.string().default("gpt-4.1-mini"),
  SARVAM_API_KEY: z.string().default(""),
  BRAIN_PATH: z.string().default("/brain/brain.md"),
  WAKE_WORD: z.string().default("renate"),
  VA_SETTLE_MS: z.coerce.number().default(800),
  VA_SETTLE_MAX_MS: z.coerce.number().default(1100),
  VA_SETTLE_MIN_MS: z.coerce.number().default(500),
  VA_MAX_QUESTION_MS: z.coerce.number().default(8000),
  VA_COOLDOWN_MS: z.coerce.number().default(400),
  VA_ENGAGED_WINDOW_MS: z.coerce.number().default(180_000),
  VA_STREAMING: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  VA_ANSWER_MAX_TOKENS: z.coerce.number().default(120),
  MIC_SINK: z.string().default("mic_sink"),
  FAKE_MIC_PATH: z.string().default("/tmp/fake-mic.wav"),
  TTS_LANGUAGE: z.string().default("en-IN"),
  TTS_SPEAKER: z.string().default("shubh"),
  TTS_MODEL: z.string().default("bulbul:v3"),
  // Sarvam reads "Renate" as three Italian syllables ("re-na-te"). Override
  // the spelling at synthesis time so the brand sounds like "ren-ATE"
  // (rhymes with "late"). Keep this overridable so the user can A/B
  // alternative phonetic spellings without rebuilding.
  TTS_RENATE_PRONUNCIATION: z.string().default("Ren-ate"),
});

export type BotConfig = z.infer<typeof schema>;

export function loadConfig(): BotConfig {
  return schema.parse(process.env);
}

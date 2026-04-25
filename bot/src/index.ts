import pino from "pino";
import { loadConfig } from "./config.js";
import { joinMeetWithRetry, leaveMeet } from "./join.js";
import type { JoinResult } from "./join.js";
import { attachCaptionObserver } from "./captions.js";
import type { CaptionObserverHandle } from "./captions.js";
import { waitForCallEnd } from "./endDetect.js";
import { createRedis, startHeartbeat } from "./state.js";
import { createVoiceAssistant } from "./voiceAssistant/index.js";
import type { VoiceAssistant } from "./voiceAssistant/index.js";

const log = pino({ name: "bot", level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const cfg = loadConfig();

  if (!cfg.SESSION_ID || !cfg.MEET_URL) {
    log.error(
      { sessionId: cfg.SESSION_ID, meetUrl: cfg.MEET_URL },
      "SESSION_ID and MEET_URL are required"
    );
    process.exit(2);
  }

  log.info({ sessionId: cfg.SESSION_ID, meetUrl: cfg.MEET_URL }, "bot: boot");

  const redis = createRedis(cfg.REDIS_URL);

  const heartbeat = startHeartbeat(redis, cfg.SESSION_ID, {
    intervalMs: cfg.HEARTBEAT_INTERVAL_MS,
    ttlSeconds: cfg.HEARTBEAT_TTL_SECONDS,
  });

  let joined: JoinResult | null = null;
  let captions: CaptionObserverHandle | null = null;
  let assistant: VoiceAssistant | null = null;

  const shutdown = async (sig: string, code = 0) => {
    log.info({ sig }, "bot: shutting down");
    heartbeat.stop();
    if (assistant) await assistant.stop().catch((err) => log.error({ err }, "assistant stop"));
    if (captions) await captions.stop().catch((err) => log.error({ err }, "captions stop"));
    if (joined) await leaveMeet(joined).catch((err) => log.error({ err }, "leave"));
    await redis.quit().catch(() => {});
    process.exit(code);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  try {
    joined = await joinMeetWithRetry({
      meetUrl: cfg.MEET_URL,
      authProfile: cfg.AUTH_PROFILE,
      displayName: cfg.DISPLAY_NAME,
    });
    log.info({ joinedAt: joined.joinedAt }, "bot: joined");

    if (cfg.VA_ENABLED) {
      if (!cfg.OPENAI_API_KEY || !cfg.SARVAM_API_KEY) {
        log.warn(
          { hasOpenai: !!cfg.OPENAI_API_KEY, hasSarvam: !!cfg.SARVAM_API_KEY },
          "VA_ENABLED but API keys missing; assistant disabled"
        );
      } else {
        try {
          assistant = await createVoiceAssistant({
            page: joined.page,
            openaiKey: cfg.OPENAI_API_KEY,
            sarvamKey: cfg.SARVAM_API_KEY,
            brainPath: cfg.BRAIN_PATH,
            wakeWord: cfg.WAKE_WORD,
            displayName: cfg.DISPLAY_NAME,
            micSink: cfg.MIC_SINK,
            settleMs: cfg.VA_SETTLE_MS,
            maxQuestionMs: cfg.VA_MAX_QUESTION_MS,
            cooldownMs: cfg.VA_COOLDOWN_MS,
            ttsLanguage: cfg.TTS_LANGUAGE,
            ttsSpeaker: cfg.TTS_SPEAKER,
            ttsModel: cfg.TTS_MODEL,
            answerModel: cfg.OPENAI_ANSWER_MODEL,
            answerMaxTokens: cfg.VA_ANSWER_MAX_TOKENS,
            streaming: cfg.VA_STREAMING,
          });
          log.info({ wakeWord: cfg.WAKE_WORD }, "voice assistant ready");
        } catch (err) {
          log.error({ err }, "voice assistant init failed; continuing without it");
          assistant = null;
        }
      }
    }

    captions = await attachCaptionObserver(joined.page, async (c) => {
      if (assistant) {
        assistant.handle(c).catch((err) =>
          log.error({ err }, "assistant.handle failed")
        );
      }
    });

    log.info("bot: captions live; watching for call end");

    const endSignal = await waitForCallEnd(joined.page, {
      hardTimeoutMs: cfg.CALL_HARD_TIMEOUT_MS,
    });
    log.info({ endSignal }, "bot: call ended");
    await shutdown("END_SIGNAL");
  } catch (err) {
    log.error({ err }, "bot: fatal during boot");
    await shutdown("ERROR", 1);
  }
}

main().catch((err) => {
  log.error({ err }, "bot: fatal");
  process.exit(1);
});

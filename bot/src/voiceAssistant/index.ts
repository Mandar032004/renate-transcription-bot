import type { Page } from "playwright";
import pino from "pino";
import type { DomCaption } from "../captions.js";
import { loadBrain } from "./brain.js";
import { matchWakeWord } from "./wakeWord.js";
import { QuestionAccumulator, type AccumulatorSettleMeta } from "./questionAccumulator.js";
import { canAccept, suppressesCaptions, type VaState } from "./stateMachine.js";
import { answer, answerStream } from "./answerer.js";
import { synthesize } from "./tts.js";
import { speak, playWavBuffer } from "./speak.js";
import { setMicMuted } from "../join.js";

const log = pino({ name: "bot.va", level: process.env.LOG_LEVEL ?? "info" });

export interface VoiceAssistantOptions {
  page: Page;
  openaiKey: string;
  sarvamKey: string;
  brainPath: string;
  wakeWord: string;
  displayName: string;
  micSink: string;
  settleMs: number;
  maxQuestionMs: number;
  cooldownMs: number;
  ttsLanguage: string;
  ttsSpeaker: string;
  ttsModel: string;
  answerModel: string;
  answerMaxTokens: number;
  streaming: boolean;
}

export interface VoiceAssistant {
  handle(c: DomCaption): Promise<void>;
  stop(): Promise<void>;
}

export async function createVoiceAssistant(
  opts: VoiceAssistantOptions
): Promise<VoiceAssistant> {
  const brain = await loadBrain(opts.brainPath);

  let state: VaState = "IDLE";
  let accumulator: QuestionAccumulator | null = null;
  let stopped = false;

  const setState = (next: VaState) => {
    log.info({ from: state, to: next }, "va state");
    state = next;
  };

  const runAnswer = async (question: string, meta: AccumulatorSettleMeta) => {
    accumulator = null;
    if (!question.trim()) {
      log.warn("empty question after accumulation; returning to idle");
      setState("IDLE");
      return;
    }

    // All timings relative to `stopAt` = last caption update = user-perceived
    // "finished speaking". audioStartMs is the metric we optimize for.
    const t0 = meta.stopAt;
    const ms = (t?: number) => (t ?? Date.now()) - t0;
    const timings: {
      settleMs: number;
      llmStartMs?: number;
      firstTokenMs?: number;
      firstChunkMs?: number;
      llmEndMs?: number;
      ttsStartMs?: number;
      ttsEndMs?: number;
      unmuteStartMs?: number;
      unmuteEndMs?: number;
      audioStartMs?: number;
      audioEndMs?: number;
      streaming: boolean;
      sentencesCount: number;
      unmuted: boolean;
    } = {
      settleMs: ms(),
      streaming: opts.streaming,
      sentencesCount: 0,
      unmuted: false,
    };

    setState("THINKING");
    try {
      if (opts.streaming) {
        await runStreaming(question, timings, ms);
      } else {
        await runNonStreaming(question, timings, ms);
      }
    } catch (err) {
      log.error({ err, timings }, "va run failed");
    }

    log.info({ timings }, "va timings");

    setState("COOLDOWN");
    await new Promise((r) => setTimeout(r, opts.cooldownMs));
    if (!stopped) setState("IDLE");
  };

  type Timings = {
    settleMs: number;
    llmStartMs?: number;
    firstTokenMs?: number;
    firstChunkMs?: number;
    llmEndMs?: number;
    ttsStartMs?: number;
    ttsEndMs?: number;
    unmuteStartMs?: number;
    unmuteEndMs?: number;
    audioStartMs?: number;
    audioEndMs?: number;
    streaming: boolean;
    sentencesCount: number;
    unmuted: boolean;
  };
  type MsFn = (t?: number) => number;

  const runNonStreaming = async (question: string, timings: Timings, ms: MsFn): Promise<void> => {
    timings.llmStartMs = ms();
    let reply: string;
    try {
      reply = await answer({
        question,
        brain,
        openaiKey: opts.openaiKey,
        model: opts.answerModel,
        maxTokens: opts.answerMaxTokens,
      });
      timings.llmEndMs = ms();
    } catch (err) {
      log.error({ err, timings }, "answer failed");
      return;
    }

    log.info({ reply, llmMs: (timings.llmEndMs ?? 0) - (timings.llmStartMs ?? 0) }, "va reply");
    if (stopped) return;

    setState("SPEAKING");
    // Run TTS synthesis and mic unmute concurrently — unmute has to poll for
    // the aria-label flip (up to ~1.5s) and we don't need the audio bytes
    // to start that.
    timings.ttsStartMs = ms();
    timings.unmuteStartMs = ms();
    const [wav, unmuted] = await Promise.all([
      synthesize({
        text: reply,
        apiKey: opts.sarvamKey,
        languageCode: opts.ttsLanguage,
        speaker: opts.ttsSpeaker,
        model: opts.ttsModel,
      }).then((w) => {
        timings.ttsEndMs = ms();
        return w;
      }),
      setMicMuted(opts.page, false).then((u) => {
        timings.unmuteEndMs = ms();
        return u;
      }),
    ]);
    timings.unmuted = unmuted;
    if (!unmuted) {
      log.warn({ timings }, "could not unmute mic; skipping speak");
      return;
    }
    timings.sentencesCount = 1;
    try {
      await speak({
        page: opts.page,
        wav,
        micSink: opts.micSink,
        alreadyUnmuted: true,
        onAudioStart: () => {
          timings.audioStartMs = ms();
        },
        onAudioEnd: () => {
          timings.audioEndMs = ms();
        },
      });
    } catch (err) {
      log.error({ err, timings }, "speak failed");
    }
  };

  const runStreaming = async (question: string, timings: Timings, ms: MsFn): Promise<void> => {
    // Streaming pipeline:
    //   OpenAI stream → sentence chunks → per-sentence TTS (parallel) →
    //   sequential paplay (chained by arrival order). Unmute runs in
    //   parallel with the first sentence's TTS.
    //
    // audioStartMs drops from `settle + fullLLM + fullTTS` to
    // `settle + firstTokenLatency + firstSentenceTail + firstSentenceTTS`.
    timings.llmStartMs = ms();
    timings.unmuteStartMs = ms();
    const unmutePromise = setMicMuted(opts.page, false).then((u) => {
      timings.unmuteEndMs = ms();
      return u;
    });

    setState("SPEAKING");

    const replyParts: string[] = [];
    let playChain: Promise<void> = Promise.resolve();
    let aborted = false;

    const ctrl = new AbortController();
    const stream = answerStream({
      question,
      brain,
      openaiKey: opts.openaiKey,
      model: opts.answerModel,
      maxTokens: opts.answerMaxTokens,
      signal: ctrl.signal,
    });

    try {
      for await (const chunk of stream) {
        if (stopped || aborted) {
          ctrl.abort();
          break;
        }
        if (timings.firstTokenMs === undefined) {
          // answerStream's internal first-token log fires at first delta.
          // We get the first *chunk* only after a sentence boundary, so
          // firstChunkMs is the more accurate metric here.
          timings.firstTokenMs = ms();
        }
        if (timings.firstChunkMs === undefined) {
          timings.firstChunkMs = ms();
          timings.ttsStartMs = ms();
        }

        replyParts.push(chunk.text);
        const idx = chunk.index;
        const ttsPromise = synthesize({
          text: chunk.text,
          apiKey: opts.sarvamKey,
          languageCode: opts.ttsLanguage,
          speaker: opts.ttsSpeaker,
          model: opts.ttsModel,
        });

        // Chain this sentence's playback after the prior sentence's
        // playback. The chain awaits both this sentence's TTS and (for
        // the first sentence) the unmute before calling paplay.
        const priorPlay = playChain;
        playChain = (async () => {
          let wav: Buffer;
          try {
            wav = await ttsPromise;
          } catch (err) {
            log.error({ err, idx }, "sentence tts failed; aborting stream");
            aborted = true;
            ctrl.abort();
            return;
          }
          if (idx === 0) {
            const unmuted = await unmutePromise;
            timings.unmuted = unmuted;
            if (!unmuted) {
              log.warn({ idx }, "could not unmute mic; skipping speak");
              aborted = true;
              return;
            }
            timings.ttsEndMs = ms();
          }
          await priorPlay;
          if (stopped || aborted) return;
          try {
            await playWavBuffer(
              wav,
              opts.micSink,
              () => {
                if (timings.audioStartMs === undefined) timings.audioStartMs = ms();
              },
              () => {
                timings.audioEndMs = ms();
              }
            );
            timings.sentencesCount++;
          } catch (err) {
            log.error({ err, idx }, "sentence play failed");
            aborted = true;
          }
        })();
      }
      timings.llmEndMs = ms();
    } catch (err) {
      // Stream errored after yielding some chunks — let what we have drain
      // to paplay instead of swallowing already-good sentences. Don't
      // toggle `aborted`; that's reserved for TTS failures and shutdown.
      log.error({ err, timings }, "llm stream failed");
    }

    // Wait for the last queued sentence to finish playing.
    await playChain.catch(() => {});

    // Make sure we re-mute even if we never entered the play path (e.g.
    // unmute failed or LLM returned nothing). setMicMuted(true) is
    // idempotent and cheap.
    try {
      await setMicMuted(opts.page, true);
    } catch (err) {
      log.error({ err }, "re-mute failed");
    }

    const reply = replyParts.join(" ").replace(/\s+/g, " ").trim();
    log.info(
      {
        reply,
        llmMs:
          timings.llmEndMs !== undefined && timings.llmStartMs !== undefined
            ? timings.llmEndMs - timings.llmStartMs
            : undefined,
        firstChunkMs: timings.firstChunkMs,
        sentencesCount: timings.sentencesCount,
      },
      "va reply (streaming)"
    );
  };

  return {
    async handle(c: DomCaption) {
      if (stopped) return;

      log.info(
        { state, speaker: c.speaker, textHead: c.text.slice(0, 80) },
        "va caption received"
      );

      // Suppress everything while speaking or cooling down — guards against
      // our own voice triggering another wake.
      if (suppressesCaptions(state)) return;

      // Never trigger on captions attributed to ourselves or to no one.
      // Meet labels the local participant as "You" regardless of displayName,
      // and rows whose badge never resolved arrive with speaker === "" — both
      // must be rejected, otherwise late self-captions slip through after the
      // bot finishes speaking and re-fire the wake word.
      if (!c.speaker || c.speaker === opts.displayName || c.speaker === "You") return;

      if (state === "ACCUMULATING") {
        accumulator?.feed(c);
        return;
      }

      if (!canAccept(state)) return;

      const match = matchWakeWord(c.text, opts.wakeWord);
      if (!match.matched) return;

      log.info({ speaker: c.speaker, tail: match.tail }, "wake word fired");
      setState("ACCUMULATING");
      accumulator = new QuestionAccumulator({
        settleMs: opts.settleMs,
        maxQuestionMs: opts.maxQuestionMs,
        wakeWord: opts.wakeWord,
        onSettle: (q, meta) => {
          log.info({ question: q, settleReason: meta.reason }, "va question (post-settle)");
          void runAnswer(q, meta);
        },
      });
      accumulator.start(c);
    },
    async stop() {
      stopped = true;
      accumulator?.cancel();
      accumulator = null;
      // Best-effort: ensure mic is muted on shutdown regardless of state.
      try {
        await setMicMuted(opts.page, true);
      } catch (err) {
        log.error({ err }, "shutdown mute failed");
      }
    },
  };
}

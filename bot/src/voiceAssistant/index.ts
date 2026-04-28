import type { Page } from "playwright";
import pino from "pino";
import type { DomCaption } from "../captions.js";
import { setMicMuted } from "../join.js";
import { answer, answerStream } from "./answerer.js";
import { loadBrain } from "./brain.js";
import { MeetingMemory } from "./meetingMemory.js";
import { QuestionAccumulator, type AccumulatorSettleMeta } from "./questionAccumulator.js";
import { speak, playWavBuffer } from "./speak.js";
import { canAccept, suppressesAction, type VaState } from "./stateMachine.js";
import { synthesize } from "./tts.js";
import { matchWakeWord } from "./wakeWord.js";

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

export async function createVoiceAssistant(
  opts: VoiceAssistantOptions
): Promise<VoiceAssistant> {
  const brain = await loadBrain(opts.brainPath);
  const memory = new MeetingMemory({ displayName: opts.displayName });

  let state: VaState = "IDLE";
  let accumulator: QuestionAccumulator | null = null;
  let stopped = false;
  let activeAbort: AbortController | null = null;
  let activeInterrupt: "stop" | "question" | null = null;
  let cooldownAbort: AbortController | null = null;

  const setState = (next: VaState) => {
    log.info({ from: state, to: next }, "va state");
    state = next;
  };

  const runAnswer = async (
    question: string,
    meta: AccumulatorSettleMeta,
    speaker: string
  ) => {
    accumulator = null;
    const cleaned = question.trim();
    const bareWakePattern = new RegExp(`^${escapeRegex(opts.wakeWord)}[\\s,!?\\.]*$`, "i");
    if (!cleaned || bareWakePattern.test(cleaned)) {
      log.warn("empty question after accumulation; returning to idle");
      setState("IDLE");
      return;
    }

    const t0 = meta.stopAt;
    const ms = (t?: number) => (t ?? Date.now()) - t0;
    const timings: Timings = {
      settleMs: ms(),
      streaming: opts.streaming,
      sentencesCount: 0,
      unmuted: false,
    };

    setState("THINKING");
    let reply = "";
    const runAbort = new AbortController();
    activeAbort = runAbort;
    activeInterrupt = null;
    try {
      reply = opts.streaming
        ? await runStreaming(question, timings, ms, runAbort.signal, speaker)
        : await runNonStreaming(question, timings, ms, runAbort.signal, speaker);
    } catch (err) {
      if (runAbort.signal.aborted) {
        log.info({ interrupt: activeInterrupt, timings }, "va run aborted");
      } else {
        log.error({ err, timings }, "va run failed");
      }
    } finally {
      if (activeAbort === runAbort) activeAbort = null;
    }

    if (reply && !runAbort.signal.aborted) memory.markInteraction(speaker, reply);
    log.info({ timings }, "va timings");

    if (runAbort.signal.aborted) {
      if (activeInterrupt === "stop") {
        activeInterrupt = null;
        if (!stopped && state !== "ACCUMULATING") setState("IDLE");
      }
      return;
    }

    setState("COOLDOWN");
    const cAbort = new AbortController();
    cooldownAbort = cAbort;
    await waitInterruptible(opts.cooldownMs, cAbort.signal);
    if (cooldownAbort === cAbort) cooldownAbort = null;
    // Guard so a wake-word that short-circuited cooldown (and already moved
    // us to IDLE → ACCUMULATING) does not get clobbered back to IDLE.
    if (!stopped && state === "COOLDOWN") setState("IDLE");
  };

  const runNonStreaming = async (
    question: string,
    timings: Timings,
    ms: MsFn,
    signal: AbortSignal,
    asker: string
  ): Promise<string> => {
    timings.llmStartMs = ms();
    let reply: string;
    try {
      reply = await answer({
        question,
        brain,
        meetingContext: memory.contextFor(question),
        asker,
        openaiKey: opts.openaiKey,
        model: opts.answerModel,
        maxTokens: opts.answerMaxTokens,
      });
      timings.llmEndMs = ms();
    } catch (err) {
      log.error({ err, timings }, "answer failed");
      return "";
    }

    log.info({ reply, llmMs: (timings.llmEndMs ?? 0) - (timings.llmStartMs ?? 0) }, "va reply");
    if (stopped) return reply;

    setState("SPEAKING");
    timings.ttsStartMs = ms();
    timings.unmuteStartMs = ms();
    const [wav, unmuted] = await Promise.all([
      synthesize({
        text: reply,
        apiKey: opts.sarvamKey,
        languageCode: opts.ttsLanguage,
        speaker: opts.ttsSpeaker,
        model: opts.ttsModel,
        signal,
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
      return reply;
    }
    timings.sentencesCount = 1;
    try {
      await speak({
        page: opts.page,
        wav,
        micSink: opts.micSink,
        alreadyUnmuted: true,
        signal,
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
    return reply;
  };

  const runStreaming = async (
    question: string,
    timings: Timings,
    ms: MsFn,
    signal: AbortSignal,
    asker: string
  ): Promise<string> => {
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
    const abortStream = () => ctrl.abort();
    signal.addEventListener("abort", abortStream, { once: true });
    const stream = answerStream({
      question,
      brain,
      meetingContext: memory.contextFor(question),
      asker,
      openaiKey: opts.openaiKey,
      model: opts.answerModel,
      maxTokens: opts.answerMaxTokens,
      signal: ctrl.signal,
    });

    try {
      for await (const chunk of stream) {
        if (stopped || aborted || signal.aborted) {
          ctrl.abort();
          break;
        }
        if (timings.firstTokenMs === undefined) timings.firstTokenMs = ms();
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
          signal,
        });

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
          if (stopped || aborted || signal.aborted) return;
          try {
            await playWavBuffer(
              wav,
              opts.micSink,
              () => {
                if (timings.audioStartMs === undefined) timings.audioStartMs = ms();
              },
              () => {
                timings.audioEndMs = ms();
              },
              signal
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
      if (signal.aborted) {
        log.info({ timings }, "llm stream aborted");
      } else {
        log.error({ err, timings }, "llm stream failed");
      }
    } finally {
      signal.removeEventListener("abort", abortStream);
    }

    await playChain.catch(() => {});
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
    return reply;
  };

  return {
    async handle(c: DomCaption) {
      if (stopped) return;

      log.info(
        { state, speaker: c.speaker, textHead: c.text.slice(0, 80) },
        "va caption received"
      );

      const isHuman = !!c.speaker && c.speaker !== opts.displayName && c.speaker !== "You";
      if (isHuman) memory.observe(c);

      if (isHuman && (state === "THINKING" || state === "SPEAKING")) {
        const match = matchWakeWord(c.text, opts.wakeWord);
        if (isStopCommand(c.text)) {
          log.info({ speaker: c.speaker, text: c.text }, "stop command received; aborting reply");
          activeInterrupt = "stop";
          activeAbort?.abort();
          accumulator?.cancel();
          accumulator = null;
          setState("IDLE");
          return;
        }
        if (match.matched || isLikelyQuestion(c.text)) {
          log.info(
            { speaker: c.speaker, text: c.text, wake: match.matched },
            "human interruption question received"
          );
          activeInterrupt = "question";
          activeAbort?.abort();
          beginAccumulating(c, match.matched ? "wake word fired" : "interrupt question accepted");
          return;
        }
      }

      // During COOLDOWN, allow a fresh wake-word or a same-speaker follow-up
      // to short-circuit the wait, so back-to-back questions feel natural
      // instead of the bot ignoring you for a fixed window.
      if (state === "COOLDOWN" && isHuman) {
        const cdMatch = matchWakeWord(c.text, opts.wakeWord);
        const cdFollowUp = !cdMatch.matched && memory.canTreatAsFollowUp(c);
        if (cdMatch.matched || cdFollowUp) {
          log.info(
            { speaker: c.speaker, wake: cdMatch.matched, followUp: cdFollowUp },
            "short-circuiting cooldown"
          );
          cooldownAbort?.abort();
          setState("IDLE");
          // Fall through to the IDLE handling below.
        }
      }

      if (suppressesAction(state)) return;
      if (!isHuman) return;

      if (state === "ACCUMULATING") {
        accumulator?.feed(c);
        return;
      }

      if (!canAccept(state)) return;

      const match = matchWakeWord(c.text, opts.wakeWord);
      const isFollowUp = !match.matched && memory.canTreatAsFollowUp(c);
      if (!match.matched && !isFollowUp) return;

      beginAccumulating(c, match.matched ? "wake word fired" : "follow-up question accepted", {
        tail: match.tail,
        followUp: isFollowUp,
      });
    },
    async stop() {
      stopped = true;
      activeAbort?.abort();
      cooldownAbort?.abort();
      accumulator?.cancel();
      accumulator = null;
      try {
        await setMicMuted(opts.page, true);
      } catch (err) {
        log.error({ err }, "shutdown mute failed");
      }
    },
  };

  function beginAccumulating(
    c: DomCaption,
    msg: string,
    extra: Record<string, unknown> = {}
  ): void {
    setState("ACCUMULATING");
    accumulator?.cancel();
    accumulator = new QuestionAccumulator({
      settleMs: opts.settleMs,
      maxQuestionMs: opts.maxQuestionMs,
      onSettle: (q, meta) => {
        log.info({ question: q, settleReason: meta.reason }, "va question (post-settle)");
        void runAnswer(q, meta, c.speaker);
      },
    });
    log.info({ speaker: c.speaker, ...extra }, msg);
    accumulator.start(c);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function waitInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isStopCommand(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return /^(stop|stop it|renate stop|hey renate stop|okay stop|ok stop|enough|cancel|be quiet|mute)$/.test(
    normalized
  );
}

function isLikelyQuestion(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  if (normalized.includes("?")) return true;
  return /\b(what|why|how|when|where|who|which|can|could|should|would|do|does|did|is|are|will)\b/.test(
    normalized
  );
}

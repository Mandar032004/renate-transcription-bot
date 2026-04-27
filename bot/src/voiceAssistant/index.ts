import type { Page } from "playwright";
import pino from "pino";
import type { DomCaption } from "../captions.js";
import { setMicMuted } from "../join.js";
import { answer, answerStream } from "./answerer.js";
import { loadBrain } from "./brain.js";
import { MeetingMemory } from "./meetingMemory.js";
import { QuestionAccumulator, type AccumulatorSettleMeta } from "./questionAccumulator.js";
import { speak, playWavBuffer } from "./speak.js";
import { canAccept, suppressesCaptions, type VaState } from "./stateMachine.js";
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
    try {
      reply = opts.streaming
        ? await runStreaming(question, timings, ms)
        : await runNonStreaming(question, timings, ms);
    } catch (err) {
      log.error({ err, timings }, "va run failed");
    }

    if (reply) memory.markInteraction(speaker, reply);
    log.info({ timings }, "va timings");

    setState("COOLDOWN");
    await new Promise((r) => setTimeout(r, opts.cooldownMs));
    if (!stopped) setState("IDLE");
  };

  const runNonStreaming = async (
    question: string,
    timings: Timings,
    ms: MsFn
  ): Promise<string> => {
    timings.llmStartMs = ms();
    let reply: string;
    try {
      reply = await answer({
        question,
        brain,
        meetingContext: memory.contextFor(question),
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
    ms: MsFn
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
    const stream = answerStream({
      question,
      brain,
      meetingContext: memory.contextFor(question),
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
      log.error({ err, timings }, "llm stream failed");
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

      if (suppressesCaptions(state)) return;
      if (!isHuman) return;

      if (state === "ACCUMULATING") {
        accumulator?.feed(c);
        return;
      }

      if (!canAccept(state)) return;

      const match = matchWakeWord(c.text, opts.wakeWord);
      const isFollowUp = !match.matched && memory.canTreatAsFollowUp(c);
      if (!match.matched && !isFollowUp) return;

      log.info(
        { speaker: c.speaker, tail: match.tail, followUp: isFollowUp },
        match.matched ? "wake word fired" : "follow-up question accepted"
      );
      setState("ACCUMULATING");
      accumulator = new QuestionAccumulator({
        settleMs: opts.settleMs,
        maxQuestionMs: opts.maxQuestionMs,
        onSettle: (q, meta) => {
          log.info({ question: q, settleReason: meta.reason }, "va question (post-settle)");
          void runAnswer(q, meta, c.speaker);
        },
      });
      accumulator.start(c);
    },
    async stop() {
      stopped = true;
      accumulator?.cancel();
      accumulator = null;
      try {
        await setMicMuted(opts.page, true);
      } catch (err) {
        log.error({ err }, "shutdown mute failed");
      }
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

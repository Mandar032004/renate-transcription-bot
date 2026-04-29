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
  settleMinMs: number;
  settleMaxMs: number;
  maxQuestionMs: number;
  cooldownMs: number;
  engagedWindowMs: number;
  ttsLanguage: string;
  ttsSpeaker: string;
  ttsModel: string;
  answerModel: string;
  answerMaxTokens: number;
  answerTemperature: number;
  stopPhrases: string[];
  resumePhrases: string[];
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

interface ActiveReplyState {
  question: string;
  asker: string;
  chunks: string[];
  playedCount: number;
  finalReply: string;
  complete: boolean;
}

type ResumeState =
  | {
      kind: "speak";
      question: string;
      asker: string;
      remainingChunks: string[];
      finalReply: string;
    }
  | {
      // Used when the LLM was cut off mid-stream. We call the model again
      // with the text the user already heard so it picks up where it left
      // off instead of restarting with a fresh, possibly-different answer.
      kind: "continue";
      question: string;
      asker: string;
      partialText: string;
    };

export async function createVoiceAssistant(
  opts: VoiceAssistantOptions
): Promise<VoiceAssistant> {
  const brain = await loadBrain(opts.brainPath);
  const memory = new MeetingMemory({
    displayName: opts.displayName,
    engagedWindowMs: opts.engagedWindowMs,
  });

  let state: VaState = "IDLE";
  let accumulator: QuestionAccumulator | null = null;
  let stopped = false;
  let activeAbort: AbortController | null = null;
  let activeInterrupt: "stop" | "question" | null = null;
  let cooldownAbort: AbortController | null = null;
  let activeReply: ActiveReplyState | null = null;
  let resumeState: ResumeState | null = null;
  let activeQuestionSource: { speaker: string; tStart: number } | null = null;

  const setState = (next: VaState) => {
    log.info({ from: state, to: next }, "va state");
    state = next;
  };

  const runAnswer = async (
    question: string,
    meta: AccumulatorSettleMeta,
    speaker: string,
    partialAnswer?: string
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
    const replyState: ActiveReplyState = {
      question,
      asker: speaker,
      chunks: [],
      playedCount: 0,
      finalReply: partialAnswer ?? "",
      complete: false,
    };
    activeReply = replyState;
    resumeState = null;

    setState("THINKING");
    let reply = "";
    const runAbort = new AbortController();
    activeAbort = runAbort;
    activeInterrupt = null;
    try {
      reply = opts.streaming
        ? await runStreaming(question, timings, ms, runAbort.signal, speaker, replyState, partialAnswer)
        : await runNonStreaming(question, timings, ms, runAbort.signal, speaker, replyState, partialAnswer);
    } catch (err) {
      if (runAbort.signal.aborted) {
        log.info({ interrupt: activeInterrupt, timings }, "va run aborted");
      } else {
        log.error({ err, timings }, "va run failed");
      }
    } finally {
      if (runAbort.signal.aborted && activeInterrupt === "stop") {
        resumeState = buildResumeState(replyState);
      }
      if (activeReply === replyState) activeReply = null;
      if (activeAbort === runAbort) activeAbort = null;
    }

    if (reply && !runAbort.signal.aborted) memory.markInteraction(speaker, reply);
    if ((timings.audioStartMs ?? Number.POSITIVE_INFINITY) > 3_000) {
      log.warn({ timings }, "va first audio exceeded 3s target");
    }
    log.info({ timings }, "va timings");

    if (runAbort.signal.aborted) {
      if (activeInterrupt === "stop") {
        activeInterrupt = null;
        activeQuestionSource = null;
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
    if (!stopped && state === "COOLDOWN") {
      activeQuestionSource = null;
      setState("IDLE");
    }
  };

  const runNonStreaming = async (
    question: string,
    timings: Timings,
    ms: MsFn,
    signal: AbortSignal,
    asker: string,
    replyState: ActiveReplyState,
    partialAnswer?: string
  ): Promise<string> => {
    timings.llmStartMs = ms();
    let continuation: string;
    try {
      continuation = await answer({
        question,
        brain,
        meetingContext: memory.contextFor(question),
        asker,
        openaiKey: opts.openaiKey,
        model: opts.answerModel,
        maxTokens: opts.answerMaxTokens,
        temperature: opts.answerTemperature,
        partialAnswer,
      });
      timings.llmEndMs = ms();
    } catch (err) {
      log.error({ err, timings }, "answer failed");
      return "";
    }

    const fullReply = partialAnswer
      ? `${partialAnswer.trim()} ${continuation}`.replace(/\s+/g, " ").trim()
      : continuation;
    replyState.finalReply = fullReply;
    replyState.complete = true;
    replyState.chunks = splitReplyForResume(continuation);

    log.info({ reply: fullReply, llmMs: (timings.llmEndMs ?? 0) - (timings.llmStartMs ?? 0) }, "va reply");
    if (stopped) return fullReply;

    setState("SPEAKING");
    timings.ttsStartMs = ms();
    timings.unmuteStartMs = ms();
    const [wav, unmuted] = await Promise.all([
      synthesize({
        text: continuation,
        apiKey: opts.sarvamKey,
        languageCode: opts.ttsLanguage,
        speaker: opts.ttsSpeaker,
        model: opts.ttsModel,
        signal,
      }).then((w) => {
        timings.ttsEndMs = ms();
        return w;
      }),
      safeSetMicMuted(opts.page, false).then((u) => {
        timings.unmuteEndMs = ms();
        return u;
      }),
    ]);
    timings.unmuted = unmuted;
    if (!unmuted) {
      log.warn({ timings }, "could not unmute mic; skipping speak");
      return fullReply;
    }
    timings.sentencesCount = 1;
    try {
      const spoke = await speak({
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
      if (spoke && !signal.aborted) replyState.playedCount = replyState.chunks.length;
    } catch (err) {
      log.error({ err, timings }, "speak failed");
    }
    return fullReply;
  };

  const runStreaming = async (
    question: string,
    timings: Timings,
    ms: MsFn,
    signal: AbortSignal,
    asker: string,
    replyState: ActiveReplyState,
    partialAnswer?: string
  ): Promise<string> => {
    timings.llmStartMs = ms();
    timings.unmuteStartMs = ms();
    const unmutePromise = safeSetMicMuted(opts.page, false).then((u) => {
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
      temperature: opts.answerTemperature,
      partialAnswer,
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
        replyState.chunks.push(chunk.text);
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
            replyState.playedCount++;
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
      await safeSetMicMuted(opts.page, true);
    } catch (err) {
      log.error({ err }, "re-mute failed");
    }

    const continuation = replyParts.join(" ").replace(/\s+/g, " ").trim();
    const reply = partialAnswer
      ? `${partialAnswer.trim()} ${continuation}`.replace(/\s+/g, " ").trim()
      : continuation;
    replyState.finalReply = reply;
    replyState.complete = !aborted && timings.llmEndMs !== undefined;
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

      // Resume can fire from IDLE (normal) or COOLDOWN (so the user doesn't
      // have to wait out the cooldown window after a stop).
      if (isHuman && resumeState && (state === "IDLE" || state === "COOLDOWN")) {
        const resumeMatch = isResumeCommand(c.text, opts.resumePhrases);
        if (resumeMatch) {
          log.info(
            { speaker: c.speaker, text: c.text, phrase: resumeMatch },
            "va resume matched"
          );
          memory.activateConversation(c.speaker);
          if (state === "COOLDOWN") {
            cooldownAbort?.abort();
            setState("IDLE");
          }
          void resumeInterrupted(c.speaker);
          return;
        }
      }

      // Stop fires from any active state. The user said "the bot should stop
      // immediately" — that means accepting stop while we're still gathering
      // the question (ACCUMULATING) and during the post-reply cooldown too,
      // not only during THINKING/SPEAKING.
      if (
        isHuman &&
        (state === "THINKING" ||
          state === "SPEAKING" ||
          state === "ACCUMULATING" ||
          state === "COOLDOWN")
      ) {
        const stopMatch = isStopCommand(c.text, opts.stopPhrases);
        if (stopMatch) {
          log.info(
            { speaker: c.speaker, text: c.text, fromState: state, phrase: stopMatch },
            "va stop matched; aborting"
          );
          activeInterrupt = "stop";
          activeAbort?.abort();
          cooldownAbort?.abort();
          accumulator?.cancel();
          accumulator = null;
          activeQuestionSource = null;
          if (state === "ACCUMULATING" || state === "COOLDOWN") {
            // Nothing to abort in these states (no in-flight reply), so we
            // need to drop straight to IDLE here. THINKING/SPEAKING states
            // unwind via the runAnswer finally block instead.
            setState("IDLE");
          }
          return;
        }
      }

      if (isHuman && (state === "THINKING" || state === "SPEAKING")) {
        if (isSameActiveUtterance(c)) return;
        if (isMeaningfulInterruption(c.text)) {
          const match = matchWakeWord(c.text, opts.wakeWord);
          log.info(
            { speaker: c.speaker, text: c.text, wake: match.matched },
            "human interruption received; barging in"
          );
          activeInterrupt = "question";
          activeAbort?.abort();
          beginAccumulating(c, match.matched ? "wake word fired" : "barge-in caption accepted", {
            tail: match.tail,
            followUp: !match.matched,
          });
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
        if (activeQuestionSource && c.speaker === activeQuestionSource.speaker && c.tStart >= activeQuestionSource.tStart) {
          activeQuestionSource = { speaker: c.speaker, tStart: c.tStart };
        }
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
        await safeSetMicMuted(opts.page, true);
      } catch (err) {
        log.error({ err }, "shutdown mute failed");
      }
    },
  };

  function beginAccumulating(
    c: DomCaption,
    msg: string,
    extra: Record<string, unknown> & { tail?: string; followUp?: boolean } = {}
  ): void {
    setState("ACCUMULATING");
    accumulator?.cancel();
    activeQuestionSource = { speaker: c.speaker, tStart: c.tStart };
    memory.activateConversation(c.speaker);
    const settleMs =
      extra.followUp || (extra.tail?.trim().length ?? 0) > 0
        ? Math.max(220, Math.floor(opts.settleMs * 0.7))
        : opts.settleMs;
    accumulator = new QuestionAccumulator({
      settleMs,
      settleMinMs: opts.settleMinMs,
      settleMaxMs: opts.settleMaxMs,
      maxQuestionMs: opts.maxQuestionMs,
      onSettle: (q, meta) => {
        log.info({ question: q, settleReason: meta.reason }, "va question (post-settle)");
        void runAnswer(q, meta, c.speaker);
      },
    });
    log.info({ speaker: c.speaker, ...extra }, msg);
    accumulator.start(c);
  }

  async function resumeInterrupted(speaker: string): Promise<void> {
    const snapshot = resumeState;
    if (!snapshot) return;
    resumeState = null;

    if (snapshot.kind === "continue") {
      log.info(
        { speaker, partialChars: snapshot.partialText.length },
        "va resume (continuation)"
      );
      await runAnswer(
        snapshot.question,
        { startAt: Date.now(), stopAt: Date.now(), reason: "settle" },
        speaker,
        snapshot.partialText
      );
      return;
    }

    const t0 = Date.now();
    const ms = (t?: number) => (t ?? Date.now()) - t0;
    const timings: Timings = {
      settleMs: 0,
      streaming: snapshot.remainingChunks.length > 1,
      sentencesCount: 0,
      unmuted: false,
    };
    const replyState: ActiveReplyState = {
      question: snapshot.question,
      asker: speaker,
      chunks: [...snapshot.remainingChunks],
      playedCount: 0,
      finalReply: snapshot.finalReply,
      complete: true,
    };

    activeReply = replyState;
    setState("SPEAKING");
    const runAbort = new AbortController();
    activeAbort = runAbort;
    activeInterrupt = null;

    try {
      await speakChunks(snapshot.remainingChunks, timings, ms, runAbort.signal, replyState);
    } catch (err) {
      if (runAbort.signal.aborted) {
        log.info({ interrupt: activeInterrupt, timings }, "va resume aborted");
      } else {
        log.error({ err, timings }, "va resume failed");
      }
    } finally {
      if (runAbort.signal.aborted && activeInterrupt === "stop") {
        resumeState = buildResumeState(replyState);
      }
      if (activeReply === replyState) activeReply = null;
      if (activeAbort === runAbort) activeAbort = null;
    }

    if (snapshot.finalReply && !runAbort.signal.aborted) {
      memory.markInteraction(speaker, snapshot.finalReply);
    }
    if ((timings.audioStartMs ?? Number.POSITIVE_INFINITY) > 3_000) {
      log.warn({ timings }, "va first audio exceeded 3s target");
    }
    log.info({ timings }, "va timings");

    if (runAbort.signal.aborted) {
      if (activeInterrupt === "stop") {
        activeInterrupt = null;
        activeQuestionSource = null;
        if (!stopped && state !== "ACCUMULATING") setState("IDLE");
      }
      return;
    }

    setState("COOLDOWN");
    const cAbort = new AbortController();
    cooldownAbort = cAbort;
    await waitInterruptible(opts.cooldownMs, cAbort.signal);
    if (cooldownAbort === cAbort) cooldownAbort = null;
    if (!stopped && state === "COOLDOWN") {
      activeQuestionSource = null;
      setState("IDLE");
    }
  }

  async function speakChunks(
    chunks: string[],
    timings: Timings,
    ms: MsFn,
    signal: AbortSignal,
    replyState: ActiveReplyState
  ): Promise<void> {
    if (chunks.length === 0) return;

    timings.unmuteStartMs = ms();
    const unmutePromise = safeSetMicMuted(opts.page, false).then((u) => {
      timings.unmuteEndMs = ms();
      return u;
    });

    const wavPromises = chunks.map((text, idx) => {
      if (idx === 0 && timings.ttsStartMs === undefined) timings.ttsStartMs = ms();
      return synthesize({
        text,
        apiKey: opts.sarvamKey,
        languageCode: opts.ttsLanguage,
        speaker: opts.ttsSpeaker,
        model: opts.ttsModel,
        signal,
      }).then((wav) => {
        if (idx === 0 && timings.ttsEndMs === undefined) timings.ttsEndMs = ms();
        return wav;
      });
    });

    const unmuted = await unmutePromise;
    timings.unmuted = unmuted;
    if (!unmuted) {
      log.warn("could not unmute mic; skipping resumed speak");
      return;
    }

    try {
      for (let idx = 0; idx < chunks.length; idx++) {
        const wav = await wavPromises[idx];
        if (signal.aborted) break;
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
        replyState.playedCount++;
      }
    } finally {
      await safeSetMicMuted(opts.page, true).catch((err) =>
        log.error({ err }, "re-mute failed")
      );
    }
  }

  function isSameActiveUtterance(c: DomCaption): boolean {
    return !!activeQuestionSource &&
      c.speaker === activeQuestionSource.speaker &&
      c.tStart === activeQuestionSource.tStart;
  }

  async function safeSetMicMuted(page: Page, muted: boolean): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (await setMicMuted(page, muted)) return true;
      if (attempt < 2) await page.waitForTimeout(120);
    }
    return false;
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

// Substring matching against a normalized phrase list. The previous
// anchored regex (`^stop$`) only fired on bare exact matches, so natural
// phrasings like "please stop talking" or "yeah, continue please" were
// dropped. We now match on token-bounded substrings so any caption that
// CONTAINS a stop/resume phrase fires the action.
function matchesPhrase(normalized: string, phrases: string[]): string | null {
  if (!normalized) return null;
  const padded = ` ${normalized} `;
  for (const phrase of phrases) {
    const p = phrase.trim().toLowerCase();
    if (!p) continue;
    if (padded.includes(` ${p} `)) return p;
  }
  return null;
}

function isStopCommand(text: string, phrases: string[]): string | null {
  return matchesPhrase(normalizeCommand(text), phrases);
}

function isResumeCommand(text: string, phrases: string[]): string | null {
  return matchesPhrase(normalizeCommand(text), phrases);
}

// Mid-reply barge-in admits any non-trivial human caption from anyone in the
// room: matching the user's "I can interfere anytime" expectation. Filler
// noise and bot-side captions are filtered out earlier; here we just guard
// against zero-content captions that would otherwise turn into empty turns.
function isMeaningfulInterruption(text: string): boolean {
  const normalized = normalizeCommand(text);
  if (normalized.length < 4) return false;
  if (/^(uh|um|hmm|mm|mhm|yeah|yep|nope|no|ok|okay|right|sure|cool|nice|wow)$/.test(normalized)) {
    return false;
  }
  return /[a-z0-9]/.test(normalized);
}

function normalizeCommand(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function buildResumeState(replyState: ActiveReplyState): ResumeState | null {
  const question = replyState.question.trim();
  if (!question) return null;

  if (replyState.complete) {
    const remainingChunks = replyState.chunks
      .slice(replyState.playedCount)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    if (remainingChunks.length > 0) {
      return {
        kind: "speak",
        question,
        asker: replyState.asker,
        remainingChunks,
        finalReply: replyState.finalReply || replyState.chunks.join(" ").trim(),
      };
    }
    return null;
  }

  // LLM was still streaming when we got cut off. The user heard only the
  // chunks fully played; everything else is buffered but unspoken. Use the
  // played chunks as the "what you already said" anchor for the
  // continuation prompt — that matches what the user actually heard.
  const partialText = replyState.chunks
    .slice(0, replyState.playedCount)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    kind: "continue",
    question,
    asker: replyState.asker,
    partialText,
  };
}

function splitReplyForResume(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = normalized
    .match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length ? parts : [normalized];
}

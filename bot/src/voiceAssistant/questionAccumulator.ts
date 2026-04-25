import type { DomCaption } from "../captions.js";
import { matchWakeWord } from "./wakeWord.js";

export interface AccumulatorSettleMeta {
  stopAt: number;   // last caption update time — proxy for "user stopped speaking"
  startAt: number;  // time of the wake-word caption
  reason: "settle" | "hard-cap";
}

export interface AccumulatorOptions {
  settleMs: number;       // idle time before we consider the question complete
  maxQuestionMs: number;  // hard cap from first wake-word hit
  wakeWord: string;       // so we can strip it from the final row on settle
  onSettle: (question: string, meta: AccumulatorSettleMeta) => void;
}

/**
 * Collects captions from the same speaker after the wake word fires. Meet
 * rewrites the caption row as the utterance grows, so we keep the *latest*
 * text per row (keyed by `speaker:tStart`) and on settle compute the tail
 * from that latest text — not from the wake-time snapshot. Without that,
 * the LLM only ever sees the prefix "What are the…" when the full question
 * is "what are the company values?".
 */
export class QuestionAccumulator {
  private speaker = "";
  private startedAt = 0;
  private lastUpdateAt = 0;
  private rows = new Map<string, string>(); // rowKey -> latest text
  private rowOrder: string[] = [];
  private settleTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private done = false;
  private readonly opts: AccumulatorOptions;

  constructor(opts: AccumulatorOptions) {
    this.opts = opts;
  }

  /** Start a fresh question from the wake-word caption. */
  start(caption: DomCaption): void {
    this.speaker = caption.speaker;
    this.startedAt = Date.now();
    this.lastUpdateAt = this.startedAt;
    this.rows.clear();
    this.rowOrder = [];
    this.done = false;

    const rowKey = this.rowKey(caption);
    this.rows.set(rowKey, caption.text);
    this.rowOrder.push(rowKey);

    this.armSettleTimer();
    this.hardTimer = setTimeout(() => this.finish("hard-cap"), this.opts.maxQuestionMs);
  }

  /** Feed a subsequent caption. Only from the same speaker is accepted. */
  feed(caption: DomCaption): void {
    if (this.done) return;
    if (caption.speaker !== this.speaker) return;
    // Drop captions whose row pre-dates this question. Guards against stale
    // rows in Meet's panel leaking into the current utterance.
    if (caption.tStart < this.startedAt - 500) return;

    const rowKey = this.rowKey(caption);
    if (this.rows.has(rowKey)) {
      this.rows.set(rowKey, caption.text);
    } else {
      this.rows.set(rowKey, caption.text);
      this.rowOrder.push(rowKey);
    }
    this.lastUpdateAt = Date.now();
    this.armSettleTimer();
  }

  /** Force-finish now (e.g., on shutdown). */
  cancel(): void {
    this.done = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.settleTimer = null;
    this.hardTimer = null;
  }

  private rowKey(c: DomCaption): string {
    return `${c.speaker}:${c.tStart}`;
  }

  private armSettleTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.finish("settle"), this.opts.settleMs);
  }

  private finish(reason: "settle" | "hard-cap"): void {
    if (this.done) return;
    this.done = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.settleTimer = null;
    this.hardTimer = null;

    // Assemble: first row has the wake word — strip it to get the question
    // tail. Subsequent rows (if any — same speaker spoke across multiple
    // Meet caption rows) are appended verbatim.
    const parts: string[] = [];
    this.rowOrder.forEach((rowKey, idx) => {
      const text = this.rows.get(rowKey) ?? "";
      if (idx === 0) {
        const m = matchWakeWord(text, this.opts.wakeWord);
        parts.push(m.matched ? m.tail : text);
      } else {
        parts.push(text);
      }
    });
    const question = parts.join(" ").replace(/\s+/g, " ").trim();
    this.opts.onSettle(question, {
      stopAt: this.lastUpdateAt,
      startAt: this.startedAt,
      reason,
    });
  }
}

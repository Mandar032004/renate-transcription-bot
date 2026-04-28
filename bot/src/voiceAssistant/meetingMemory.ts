import type { DomCaption } from "../captions.js";

export interface MeetingMemoryInput {
  displayName: string;
  maxCaptions?: number;
  maxFacts?: number;
  engagedWindowMs?: number;
}

export interface MeetingContext {
  recent: string;
  relevant: string;
  facts: string;
  previousAnswer: string;
}

interface MemoryCaption {
  speaker: string;
  text: string;
  at: number;
}

const QUESTION_RE = /\b(what|why|how|when|where|who|which|can|could|should|would|do|does|did|is|are|will)\b/i;
const FACT_RE =
  /\b(decided|agreed|need|needs|blocker|blocked|deadline|pricing|price|customer|client|candidate|interview|hire|hiring|role|requirement|integration|policy|plan|next|action|follow up|follow-up)\b/i;
const FOLLOW_UP_RE =
  /^(and|also|then|so|but|what about|how about|tell me|give me|walk me|explain|compare|summarize|list|remind me)\b/i;
const DIRECT_ADDRESS_RE = /\b(renate|you|your)\b/i;
const IMPERATIVE_RE =
  /^(tell|explain|summarize|compare|list|walk|give|share|help|remind|clarify)\b/i;

export class MeetingMemory {
  private readonly captions: MemoryCaption[] = [];
  private readonly facts: string[] = [];
  private previousAnswer = "";
  private lastHumanSpeaker = "";
  private lastAsker = "";
  private lastInteractionAt = 0;
  private engagedUntil = 0;

  constructor(private readonly input: MeetingMemoryInput) {}

  observe(caption: DomCaption): void {
    const speaker = caption.speaker.trim();
    const text = cleanText(caption.text);
    if (!speaker || !text) return;
    if (speaker === this.input.displayName || speaker === "You") return;

    this.lastHumanSpeaker = speaker;

    const previous = this.captions[this.captions.length - 1];
    if (
      previous &&
      previous.speaker === speaker &&
      Date.now() - previous.at < 8_000 &&
      (text.startsWith(previous.text) || previous.text.startsWith(text))
    ) {
      previous.text = text.length >= previous.text.length ? text : previous.text;
      previous.at = Date.now();
    } else {
      this.captions.push({ speaker, text, at: Date.now() });
    }

    const maxCaptions = this.input.maxCaptions ?? 120;
    while (this.captions.length > maxCaptions) this.captions.shift();

    if (FACT_RE.test(text) || QUESTION_RE.test(text)) {
      const fact = `${speaker}: ${text}`;
      if (this.facts[this.facts.length - 1] !== fact) this.facts.push(fact);
      const maxFacts = this.input.maxFacts ?? 40;
      while (this.facts.length > maxFacts) this.facts.shift();
    }
  }

  activateConversation(speaker: string): void {
    const now = Date.now();
    if (speaker) {
      this.lastHumanSpeaker = speaker;
      this.lastAsker = speaker;
    }
    this.engagedUntil = Math.max(this.engagedUntil, now + (this.input.engagedWindowMs ?? 180_000));
  }

  markInteraction(speaker: string, answer: string): void {
    const now = Date.now();
    this.lastInteractionAt = now;
    this.lastHumanSpeaker = speaker || this.lastHumanSpeaker;
    this.lastAsker = speaker || this.lastAsker;
    this.previousAnswer = cleanText(answer).slice(0, 900);
    this.engagedUntil = Math.max(this.engagedUntil, now + (this.input.engagedWindowMs ?? 180_000));
  }

  isConversationActive(): boolean {
    return this.engagedUntil > Date.now();
  }

  canTreatAsFollowUp(caption: DomCaption): boolean {
    if (!this.isConversationActive()) return false;
    if (!caption.speaker) return false;
    const text = cleanText(caption.text);
    if (text.length < 4) return false;

    const sameSpeaker = caption.speaker === this.lastAsker;
    const questionLike =
      text.includes("?") ||
      QUESTION_RE.test(text) ||
      FOLLOW_UP_RE.test(text) ||
      IMPERATIVE_RE.test(text);

    if (!questionLike) return false;
    if (sameSpeaker) return true;
    if (DIRECT_ADDRESS_RE.test(text)) return true;
    if (this.lastInteractionAt && Date.now() - this.lastInteractionAt <= 15_000) return true;
    return false;
  }

  contextFor(question: string): MeetingContext {
    const recentCaptions = this.captions.slice(-12);
    const recent = recentCaptions.map((c) => `${c.speaker}: ${c.text}`).join("\n");

    const qTerms = tokenize(question);
    const relevant = this.captions
      .map((caption) => ({
        caption,
        score: overlapScore(qTerms, tokenize(caption.text)),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.caption.at - a.caption.at)
      .slice(0, 8)
      .map((x) => `${x.caption.speaker}: ${x.caption.text}`)
      .join("\n");

    return {
      recent,
      relevant,
      facts: this.facts.slice(-12).join("\n"),
      previousAnswer: this.previousAnswer,
    };
  }
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let score = 0;
  for (const term of a) {
    if (b.has(term)) score += term.length > 6 ? 2 : 1;
  }
  return score;
}

const STOP_WORDS = new Set([
  "renate",
  "what",
  "when",
  "where",
  "which",
  "about",
  "with",
  "that",
  "this",
  "there",
  "their",
  "would",
  "could",
  "should",
  "please",
]);

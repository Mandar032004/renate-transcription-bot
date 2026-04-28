import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
import pino from "pino";

const log = pino({ name: "bot.va.brain", level: process.env.LOG_LEVEL ?? "info" });

const WARN_BYTES = 100_000;
const HARD_LIMIT_BYTES = 500_000;
const CHUNK_TARGET_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 120;
const MAX_RETRIEVAL_CHARS = 4_000;
const COMPANY_OVERVIEW_CHUNKS = 3;

export interface BrainChunk {
  id: number;
  text: string;
  terms: Set<string>;
}

export interface BrainKnowledge {
  text: string;
  chunks: BrainChunk[];
}

export interface RetrievedBrain {
  text: string;
  chunkIds: number[];
  scores: number[];
}

/**
 * Load the knowledge-base file once at boot. Supports .docx (via mammoth),
 * .md, and .txt. Throws on missing file or oversized content.
 */
export async function loadBrain(path: string): Promise<BrainKnowledge> {
  const buf = await readFile(path);
  const ext = extname(path).toLowerCase();

  let text: string;
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: buf });
    text = result.value;
    if (result.messages?.length) {
      log.debug({ messages: result.messages.slice(0, 5) }, "mammoth parse notes");
    }
  } else {
    text = buf.toString("utf8");
  }

  text = text.trim();
  const bytes = Buffer.byteLength(text, "utf8");

  if (bytes > HARD_LIMIT_BYTES) {
    throw new Error(
      `brain file ${path} is ${bytes} bytes of text; max ${HARD_LIMIT_BYTES}. ` +
        `Either shrink the file or upgrade to chunked RAG.`
    );
  }
  const brain = {
    text,
    chunks: chunkBrain(text),
  };

  if (bytes > WARN_BYTES) {
    log.warn({ path, bytes }, "brain file is large; consider chunked RAG soon");
  } else {
    log.info({ path, bytes, chunks: brain.chunks.length }, "brain loaded");
  }

  return brain;
}

export function retrieveBrain(input: BrainKnowledge, query: string): RetrievedBrain {
  const signals = detectQuerySignals(query);
  const expandedQuery = expandQuery(query, signals);
  const queryTerms = tokenize(expandedQuery);
  if (queryTerms.size === 0) {
    const fallback = signals.companyQuestion
      ? input.chunks.slice(0, COMPANY_OVERVIEW_CHUNKS)
      : input.chunks.slice(0, 3);
    return {
      text: fallback.map(formatChunk).join("\n\n"),
      chunkIds: fallback.map((c) => c.id),
      scores: fallback.map(() => 0),
    };
  }

  const ranked = input.chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, queryTerms, expandedQuery, signals),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);

  const selected = mergeWithOverview(input.chunks, ranked.slice(0, 6), signals);
  if (selected.length === 0) {
    if (!signals.companyQuestion) return { text: "", chunkIds: [], scores: [] };

    const fallback = input.chunks.slice(0, COMPANY_OVERVIEW_CHUNKS);
    return {
      text: fallback.map(formatChunk).join("\n\n"),
      chunkIds: fallback.map((c) => c.id),
      scores: fallback.map(() => 0),
    };
  }

  const parts: string[] = [];
  let chars = 0;
  const chunkIds: number[] = [];
  const scores: number[] = [];
  for (const item of selected) {
    const formatted = formatChunk(item.chunk);
    if (chars + formatted.length > MAX_RETRIEVAL_CHARS && parts.length > 0) break;
    parts.push(formatted);
    chars += formatted.length;
    chunkIds.push(item.chunk.id);
    scores.push(Number(item.score.toFixed(2)));
  }

  return { text: parts.join("\n\n"), chunkIds, scores };
}

function chunkBrain(text: string): BrainChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [text.replace(/\s+/g, " ").trim()]) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (current.length + paragraph.length + 2 <= CHUNK_TARGET_CHARS) {
      current = `${current}\n${paragraph}`;
    } else {
      chunks.push(current);
      const overlap = current.slice(Math.max(0, current.length - CHUNK_OVERLAP_CHARS));
      current = `${overlap} ${paragraph}`.trim();
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunk, idx) => ({
    id: idx + 1,
    text: chunk,
    terms: tokenize(chunk),
  }));
}

function scoreChunk(
  chunk: BrainChunk,
  queryTerms: Set<string>,
  rawQuery: string,
  signals: QuerySignals
): number {
  let score = 0;
  for (const term of queryTerms) {
    if (chunk.terms.has(term)) score += term.length > 5 ? 2 : 1;
  }

  const normalizedChunk = normalize(chunk.text);
  const phrases = normalize(rawQuery)
    .split(/\s+/)
    .filter((x) => x.length > 3);
  for (let i = 0; i < phrases.length - 1; i++) {
    const phrase = `${phrases[i]} ${phrases[i + 1]}`;
    if (normalizedChunk.includes(phrase)) score += 2.5;
  }

  if (signals.companyQuestion && chunk.id <= COMPANY_OVERVIEW_CHUNKS) score += 1.5;

  return score;
}

interface QuerySignals {
  companyQuestion: boolean;
  comparison: boolean;
  overview: boolean;
  workflow: boolean;
  outcomes: boolean;
}

function detectQuerySignals(query: string): QuerySignals {
  const normalized = normalize(query);
  const companyQuestion =
    /\brenate\b/.test(normalized) ||
    /\b(ai recruiter|recruit(?:ing|ment)? agent|recruit(?:ing|ment)|hiring)\b/.test(normalized);

  return {
    companyQuestion,
    comparison:
      /\b(compare|compared|comparison|better|best|different|difference|choose|prefer|advantage)\b/.test(
        normalized
      ),
    overview:
      companyQuestion &&
      /\b(what|who|how|why|tell|about|does|do)\b/.test(normalized),
    workflow:
      /\b(work|works|workflow|process|screen|screening|source|sourcing|shortlist|interview|call|schedule)\b/.test(
        normalized
      ),
    outcomes:
      /\b(best|better|benefit|benefits|value|worth|hours|weeks|faster|bias|audit|verification)\b/.test(
        normalized
      ),
  };
}

function expandQuery(query: string, signals: QuerySignals): string {
  const additions: string[] = [];

  if (signals.overview) {
    additions.push(
      "sources screens scores interviews verifies shortlists schedules notes autonomous recruiter"
    );
  }
  if (signals.workflow) {
    additions.push(
      "job profile sourcing parsing scoring ranking voice interview transcript shortlist scheduling"
    );
  }
  if (signals.comparison || signals.outcomes) {
    additions.push(
      "hours not weeks evidence backed verification fewer bad hires zero scheduling overhead audit trail active sourcing"
    );
  }

  return [query, ...additions].filter(Boolean).join(" ");
}

function mergeWithOverview(
  chunks: BrainChunk[],
  ranked: Array<{ chunk: BrainChunk; score: number }>,
  signals: QuerySignals
): Array<{ chunk: BrainChunk; score: number }> {
  if (!signals.companyQuestion) return ranked;

  const merged: Array<{ chunk: BrainChunk; score: number }> = [];
  const seen = new Set<number>();

  const add = (item: { chunk: BrainChunk; score: number }) => {
    if (seen.has(item.chunk.id)) return;
    seen.add(item.chunk.id);
    merged.push(item);
  };

  if (signals.overview || signals.comparison || signals.outcomes) {
    for (const chunk of chunks.slice(0, COMPANY_OVERVIEW_CHUNKS)) {
      const rankedMatch = ranked.find((item) => item.chunk.id === chunk.id);
      add(rankedMatch ?? { chunk, score: 0.5 });
    }
  }

  for (const item of ranked) add(item);
  return merged.slice(0, 6);
}

function formatChunk(chunk: BrainChunk): string {
  return `[company:${chunk.id}] ${chunk.text}`;
}

function tokenize(text: string): Set<string> {
  const words = normalize(text)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(words);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "you",
  "your",
  "are",
  "was",
  "were",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "renate",
  "can",
  "could",
  "would",
  "should",
  "about",
  "into",
  "from",
  "does",
  "did",
  "have",
  "has",
  "had",
  "our",
  "their",
  "they",
  "them",
  "his",
  "her",
  "she",
  "him",
  "its",
  "just",
  "please",
  "tell",
  "give",
  "me",
  "us",
]);

export interface WakeMatch {
  matched: boolean;
  tail: string;
}

/**
 * Match the wake word anywhere in a caption row, taking the LAST occurrence
 * as the trigger and everything after it as the question tail. Meet packs
 * multi-sentence utterances into a single row (e.g. "I've been doing X.
 * What does Renate do during Y?"), so a fixed scan window from the start
 * misses any wake word that lands later in the row. Using the last match
 * also handles users who say "Renate" twice — we treat the most recent
 * mention as the actual address to the bot.
 */
export function matchWakeWord(text: string, word: string): WakeMatch {
  if (!text || !word) return { matched: false, tail: "" };

  const normalized = text.trim();
  if (!normalized) return { matched: false, tail: "" };

  const w = word.trim();
  const pattern = new RegExp(
    `(?:^|\\b)(?:hey|ok|okay|hi)?[\\s,\\.\\!]*${escapeRegex(w)}\\b[\\s,\\.\\!\\?:;-]*`,
    "gi"
  );

  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(normalized)) !== null) {
    lastEnd = m.index + m[0].length;
    if (m[0].length === 0) pattern.lastIndex++; // guard against zero-width match loop
  }

  if (lastEnd < 0) return { matched: false, tail: "" };

  const tail = normalized.slice(lastEnd).trim();
  return { matched: true, tail };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

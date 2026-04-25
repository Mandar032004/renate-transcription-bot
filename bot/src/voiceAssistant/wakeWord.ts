export interface WakeMatch {
  matched: boolean;
  tail: string;
}

// Scan window: how many characters from the start we allow the wake word
// to appear in. Beyond this, the caption is almost certainly ambient chatter
// or a trailing remark, not an address to the bot.
const SCAN_CHARS = 40;

/**
 * Match the wake word in the beginning of a caption. We previously required
 * the wake word to be exactly at position 0, but Meet often delivers
 * caption rows with leading small-talk or the prior utterance's tail, which
 * would mask "Renate" and cause the bot to ignore the user on any turn but
 * the first. We now scan the first SCAN_CHARS characters for a word-boundary
 * "renate" (optionally preceded by one filler word) and take everything
 * after the match as the question tail.
 */
export function matchWakeWord(text: string, word: string): WakeMatch {
  if (!text || !word) return { matched: false, tail: "" };

  const normalized = text.trim();
  if (!normalized) return { matched: false, tail: "" };

  const prefix = normalized.slice(0, SCAN_CHARS).toLowerCase();
  const w = word.trim().toLowerCase();

  const pattern = new RegExp(
    `(?:^|\\b)(?:hey|ok|okay|hi)?[\\s,\\.\\!]*${escapeRegex(w)}\\b[\\s,\\.\\!\\?:;-]*`,
    "i"
  );
  const m = prefix.match(pattern);
  if (!m || m.index === undefined) return { matched: false, tail: "" };

  // Slice the tail from the ORIGINAL (untrimmed-case) text so casing &
  // punctuation in the tail are preserved.
  const endInPrefix = m.index + m[0].length;
  const tail = normalized.slice(endInPrefix).trim();
  return { matched: true, tail };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

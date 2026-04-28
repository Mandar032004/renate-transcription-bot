import { Buffer } from "node:buffer";
import pino from "pino";

const log = pino({ name: "bot.va.tts", level: process.env.LOG_LEVEL ?? "info" });

const SARVAM_TTS_ENDPOINT = "https://api.sarvam.ai/text-to-speech";

export interface SynthesizeInput {
  text: string;
  apiKey: string;
  languageCode?: string;  // e.g. "en-IN"
  speaker?: string;       // e.g. "anushka"
  model?: string;         // e.g. "bulbul:v2"
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Sarvam's English voices pronounce "Renate" as three Italian syllables
// (re-na-te). The brand should sound like "ren-ATE" (rhymes with "late"),
// so we substitute a phonetic spelling before sending to TTS. The original
// text is preserved for logs and meeting context.
const RENATE_PRONUNCIATION = process.env.TTS_RENATE_PRONUNCIATION || "Ren-ate";

function applyPronunciation(text: string): string {
  if (!RENATE_PRONUNCIATION) return text;
  return text.replace(/\bRenate\b/g, RENATE_PRONUNCIATION);
}

/**
 * Call Sarvam TTS. Returns the synthesized audio as a WAV buffer.
 * Sarvam returns base64-encoded WAV in `audios[0]`.
 */
export async function synthesize(input: SynthesizeInput): Promise<Buffer> {
  if (!input.apiKey) throw new Error("SARVAM_API_KEY missing");
  if (!input.text.trim()) throw new Error("empty tts text");

  const spokenText = applyPronunciation(input.text);
  const body = {
    text: spokenText,
    target_language_code: input.languageCode ?? "en-IN",
    speaker: input.speaker ?? "anushka",
    model: input.model ?? "bulbul:v2",
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 10_000);
  const abort = () => ctrl.abort();
  input.signal?.addEventListener("abort", abort, { once: true });

  const tStart = Date.now();
  let res: Response;
  try {
    res = await fetch(SARVAM_TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "api-subscription-key": input.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    input.signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`sarvam tts ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const json = (await res.json()) as { audios?: string[]; request_id?: string };
  const b64 = json.audios?.[0];
  if (!b64) throw new Error("sarvam tts returned no audio");

  const wav = Buffer.from(b64, "base64");
  log.info(
    { bytes: wav.length, chars: input.text.length, ttsMs: Date.now() - tStart, requestId: json.request_id },
    "tts synthesized"
  );
  return wav;
}

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
import pino from "pino";

const log = pino({ name: "bot.va.brain", level: process.env.LOG_LEVEL ?? "info" });

const WARN_BYTES = 100_000;
const HARD_LIMIT_BYTES = 500_000;

/**
 * Load the knowledge-base file once at boot. Supports .docx (via mammoth),
 * .md, and .txt. Throws on missing file or oversized content.
 */
export async function loadBrain(path: string): Promise<string> {
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
  if (bytes > WARN_BYTES) {
    log.warn({ path, bytes }, "brain file is large; consider chunked RAG soon");
  } else {
    log.info({ path, bytes }, "brain loaded");
  }

  return text;
}

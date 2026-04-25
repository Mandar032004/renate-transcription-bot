import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import pino from "pino";
import { setMicMuted } from "../join.js";

const log = pino({ name: "bot.va.speak", level: process.env.LOG_LEVEL ?? "info" });

export interface SpeakInput {
  page: Page;
  wav: Buffer;
  micSink: string;
  alreadyUnmuted?: boolean;
  onAudioStart?: () => void;
  onAudioEnd?: () => void;
}

/**
 * Play a single WAV buffer into the PulseAudio sink. Shared by both the
 * single-shot speak() path and the streaming sentence-by-sentence path.
 * Caller is responsible for unmute/re-mute lifecycle.
 */
export async function playWavBuffer(
  wav: Buffer,
  sink: string,
  onStart?: () => void,
  onEnd?: () => void
): Promise<void> {
  const tmpFile = join(tmpdir(), `tts-${randomUUID()}.wav`);
  await writeFile(tmpFile, wav);
  try {
    await playWav(tmpFile, sink, onStart, onEnd);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Speak the TTS WAV into the call.
 *
 * Path: paplay writes the WAV into the PulseAudio `mic_sink`. Chromium is
 * launched with the PulseAudio default source set to `mic_sink.monitor`
 * (see entrypoint.sh), so Meet transmits whatever we paplay into the sink.
 *
 * Sequence: unmute (verify aria flip — skipped if alreadyUnmuted) → paplay
 * (blocks until playback end) → re-mute.
 */
export async function speak(input: SpeakInput): Promise<boolean> {
  const tmpFile = join(tmpdir(), `tts-${randomUUID()}.wav`);
  await writeFile(tmpFile, input.wav);

  if (process.env.VA_DEBUG_PULSE === "true") {
    await dumpSourceOutputs().catch(() => {});
  }

  let unmutedOk = input.alreadyUnmuted ?? false;
  try {
    if (!unmutedOk) {
      unmutedOk = await setMicMuted(input.page, false);
      if (!unmutedOk) {
        log.warn("could not unmute mic; aborting speak");
        return false;
      }
    }
    await playWav(tmpFile, input.micSink, input.onAudioStart, input.onAudioEnd);
    return true;
  } catch (err) {
    log.error({ err }, "speak failed");
    return false;
  } finally {
    if (unmutedOk) {
      await setMicMuted(input.page, true).catch((err) =>
        log.error({ err }, "re-mute failed")
      );
    }
    await unlink(tmpFile).catch(() => {});
  }
}

function dumpSourceOutputs(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn("pactl", ["list", "source-outputs"]);
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", () => resolve());
    p.on("close", () => {
      // Extract compact summary: each source-output's application.name + source
      const blocks = out.split(/\n(?=Source Output #)/);
      const summary = blocks
        .map((b) => {
          const id = b.match(/Source Output #(\d+)/)?.[1];
          const app = b.match(/application\.name = "([^"]+)"/)?.[1];
          const src = b.match(/Source: (\S+)/)?.[1];
          if (!id) return null;
          return { id, app: app ?? "?", source: src ?? "?" };
        })
        .filter(Boolean);
      log.info({ sourceOutputs: summary }, "pulseaudio source-outputs");
      resolve();
    });
  });
}

function playWav(
  path: string,
  sink: string,
  onStart?: () => void,
  onEnd?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("paplay", [`--device=${sink}`, path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    onStart?.();
    let stderr = "";
    p.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      onEnd?.();
      if (code === 0) resolve();
      else reject(new Error(`paplay exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

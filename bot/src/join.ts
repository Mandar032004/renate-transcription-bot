import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.join", level: process.env.LOG_LEVEL ?? "info" });

export interface JoinResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  joinedAt: Date;
}

export interface JoinOptions {
  meetUrl: string;
  authProfile: string;
  joinTimeoutMs?: number;
  displayName?: string;
}

const DEFAULT_JOIN_TIMEOUT_MS = 60_000;

export async function joinMeet(opts: JoinOptions): Promise<JoinResult> {
  const joinTimeout = opts.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;

  // Headful inside Xvfb — headless-shell doesn't route audio to PulseAudio,
  // so we'd capture silence. See bot/docker/entrypoint.sh.
  log.info(
    { pulseServer: process.env.PULSE_SERVER, display: process.env.DISPLAY },
    "launching chromium"
  );
  const browser = await chromium.launch({
    headless: false,
    // Explicitly forward the audio env vars to Chromium so the sandboxed
    // audio service can find the PulseAudio socket. Playwright inherits
    // process.env by default, but being explicit guards against sandbox
    // scrubbing.
    env: filterEnv({
      ...process.env,
      PULSE_SERVER: process.env.PULSE_SERVER ?? "",
      DISPLAY: process.env.DISPLAY ?? ":99",
    }),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      // We DO NOT set --use-fake-device-for-media-stream. Chromium must
      // enumerate real PulseAudio devices so Meet picks up mic_sink.monitor
      // (fed by paplay during TTS) as the microphone input. The "no camera"
      // path is handled gracefully by Meet — it joins with video off.
      //
      // --use-file-for-fake-audio-capture is ALSO removed: Chromium reads
      // that file once into memory via WavAudioHandler, so mid-stream swaps
      // are ignored.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    storageState: opts.authProfile,
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone", "camera"],
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  // Minimal stealth: hide the automation flag and align a couple of
  // properties Meet's detection scripts have historically checked.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  await context.grantPermissions(["microphone", "camera"], {
    origin: "https://meet.google.com",
  });

  const page = await context.newPage();

  try {
    log.info({ meetUrl: opts.meetUrl }, "navigating to Meet");
    await page.goto(opts.meetUrl, { waitUntil: "domcontentloaded", timeout: joinTimeout });

    // Pre-join: mic + cam should be OFF before we click Join. Meet's default
    // for the bot account is usually off, but we enforce it defensively.
    await ensureMuted(page);

    // Some flows show a name input (consumer accounts, guest mode); if so,
    // fill it. Workspace authenticated accounts skip this.
    if (opts.displayName) {
      const nameInput = page.locator(selectors.preJoinNameInput);
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill(opts.displayName);
      }
    }

    // Meet shows a "Getting ready..." splash with a spinner overlay while
    // pre-join UI initializes. The Join-now button is in the DOM but
    // hidden behind the overlay — we must poll for a visible join button,
    // not just check once.
    const joinButton = await waitForVisible(
      page,
      [selectors.joinNowButton, selectors.joinHereTooButton, selectors.askToJoinButton],
      joinTimeout
    );
    if (!joinButton) {
      throw new Error("no visible join button (Meet never finished loading pre-join UI)");
    }

    log.info("clicking join");
    await joinButton.click({ timeout: joinTimeout });

    // Join success = "Leave call" button appears in the post-join UI.
    // For knock-to-join, this may take longer as host must admit; caller's
    // joinTimeoutMs should account for that.
    log.info("waiting for post-join UI");
    await page.locator(selectors.leaveCallButton).waitFor({
      state: "visible",
      timeout: joinTimeout,
    });

    // Post-join, Meet can re-enable mic/cam depending on room policy. Re-mute
    // now that we're in.
    await ensureMutedInCall(page);

    const joinedAt = new Date();
    log.info({ joinedAt }, "joined");
    return { browser, context, page, joinedAt };
  } catch (err) {
    log.error({ err }, "join failed");
    try {
      const shot = "/chunks/join-failure.png";
      await page.screenshot({ path: shot, fullPage: false });
      const labels = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("button, [role='button']"))
          .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim())
          .filter((s) => s.length > 0)
          .slice(0, 40);
      });
      const url = page.url();
      log.info({ shot, labels, url }, "join-failure diagnostic dumped");
    } catch (dumpErr) {
      log.warn({ dumpErr }, "diagnostic dump failed");
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Join with exponential backoff. Useful when Google throws a transient
 * "can't join right now" or the lobby host is slow.
 */
export async function joinMeetWithRetry(
  opts: JoinOptions,
  maxAttempts = 3
): Promise<JoinResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await joinMeet(opts);
    } catch (err) {
      lastErr = err;
      const backoffMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      log.warn({ attempt, maxAttempts, backoffMs, err }, "join failed; backing off");
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export async function leaveMeet(result: JoinResult): Promise<void> {
  try {
    const leave = result.page.locator(selectors.leaveCallButton);
    if (await leave.isVisible().catch(() => false)) {
      log.info("clicking leave");
      await leave.click({ timeout: 10_000 }).catch(() => {});
      // Give Meet a moment to record the leave event.
      await result.page.waitForTimeout(500);
    }
  } finally {
    await result.context.close().catch(() => {});
    await result.browser.close().catch(() => {});
    log.info("bot left meet");
  }
}

async function ensureMuted(page: Page): Promise<void> {
  await toggleIfOn(page, selectors.preJoinMicToggle, "mic");
  await toggleIfOn(page, selectors.preJoinCamToggle, "cam");
}

async function ensureMutedInCall(page: Page): Promise<void> {
  // In-call mic/cam buttons use the same aria-label scheme as pre-join.
  await toggleIfOn(page, selectors.preJoinMicToggle, "mic (in-call)");
  await toggleIfOn(page, selectors.preJoinCamToggle, "cam (in-call)");
}

/** Strip undefined values for Playwright's env type. */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Poll until one of the given selectors has an actually-visible match.
 * Meet's pre-join "Getting ready..." spinner keeps buttons in the DOM but
 * hidden under an overlay, so we must poll — a single visibility check
 * right after `goto` is too early. Also filters out hidden duplicates
 * that sometimes live inside collapsed menus.
 */
async function waitForVisible(
  page: Page,
  selectorList: string[],
  timeoutMs: number
): Promise<ReturnType<Page["locator"]> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectorList) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const nth = loc.nth(i);
        if (await nth.isVisible().catch(() => false)) {
          return nth;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function toggleIfOn(page: Page, selector: string, label: string): Promise<void> {
  const btn = page.locator(selector).first();
  if (!(await btn.isVisible().catch(() => false))) return;

  // aria-label flips between "Turn off <device>" (currently ON) and
  // "Turn on <device>" (currently OFF). We click only when it's ON.
  const aria = (await btn.getAttribute("aria-label").catch(() => null)) ?? "";
  if (/turn off/i.test(aria)) {
    log.info({ device: label }, "muting");
    await btn.click().catch(() => {});
  }
}

/**
 * Flip the in-call mic state. Used by the voice assistant to unmute before
 * speaking TTS and re-mute after. Returns true when the aria-label actually
 * flipped to the requested state. Callers should abort speaking if this
 * returns false (e.g., host-muted participant can't unmute).
 */
export async function setMicMuted(page: Page, muted: boolean): Promise<boolean> {
  const btn = page.locator(selectors.preJoinMicToggle).first();
  if (!(await btn.isVisible().catch(() => false))) return false;

  const aria = (await btn.getAttribute("aria-label").catch(() => null)) ?? "";
  const currentlyOn = /turn off/i.test(aria);
  const wantOn = !muted;

  if (currentlyOn === wantOn) return true;

  await btn.click().catch(() => {});

  // Verify aria-label flipped. Poll briefly — Meet's state reconciliation
  // can lag ~100ms after the click.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const a = (await btn.getAttribute("aria-label").catch(() => null)) ?? "";
    const nowOn = /turn off/i.test(a);
    if (nowOn === wantOn) {
      log.info({ muted }, "mic state changed");
      return true;
    }
    await page.waitForTimeout(100);
  }
  log.warn({ muted, aria }, "mic state did not flip after click");
  return false;
}

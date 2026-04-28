import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.endDetect", level: process.env.LOG_LEVEL ?? "info" });

export interface EndSignalOptions {
  hardTimeoutMs: number;
  aloneGraceMs?: number;
  leaveButtonMissingMs?: number;
}

/**
 * Resolves when the call should be considered ended. Returns the signal
 * name that tripped so the caller can log it.
 *
 * Signals (Promise.race, whichever fires first):
 *   - participant_count=1: only the bot is left
 *   - alone_banner: Meet's "You're the only one here" banner is visible
 *   - leave_button_missing: the "Leave call" button disappears for N seconds
 *   - hard_timeout: absolute ceiling (default 120 min)
 */
export async function waitForCallEnd(
  page: Page,
  opts: EndSignalOptions
): Promise<string> {
  const aloneGrace = opts.aloneGraceMs ?? 5_000;
  const leaveMissingGrace = opts.leaveButtonMissingMs ?? 20_000;

  const hardTimeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve("hard_timeout"), opts.hardTimeoutMs)
  );

  const aloneBanner = (async () => {
    while (true) {
      const visible = await page
        .locator(`text=${selectors.aloneBannerText}`)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        await page.waitForTimeout(aloneGrace);
        return "alone_banner";
      }
      await page.waitForTimeout(2_000);
    }
  })();

  const leaveMissing = (async () => {
    let absentSince: number | null = null;
    while (true) {
      const present = await revealAndCheckInCallControls(page);
      if (!present) {
        absentSince ??= Date.now();
        if (Date.now() - absentSince >= leaveMissingGrace) return "leave_button_missing";
      } else {
        absentSince = null;
      }
      await page.waitForTimeout(2_000);
    }
  })();

  const participantCountOne = (async () => {
    while (true) {
      const count = await readParticipantCount(page);
      if (count === 1) {
        await page.waitForTimeout(aloneGrace);
        const again = await readParticipantCount(page);
        if (again === 1) return "participant_count_1";
      }
      await page.waitForTimeout(3_000);
    }
  })();

  // When Meet ends the call for the bot, the URL usually navigates away
  // from /<meeting-code> to a home/ended page. This is a very reliable
  // signal independent of any specific DOM node.
  const urlChanged = (async () => {
    const initialPath = new URL(page.url()).pathname;
    while (true) {
      const now = new URL(page.url()).pathname;
      if (now !== initialPath) return "url_changed";
      await page.waitForTimeout(1_500);
    }
  })();

  const signal = await Promise.race([
    hardTimeout,
    aloneBanner,
    leaveMissing,
    participantCountOne,
    urlChanged,
  ]);
  log.info({ signal }, "call-end signal");
  return signal;
}

async function readParticipantCount(page: Page): Promise<number | null> {
  // Meet shows participant count on the "people" button's aria-label or
  // visible badge. aria-label typically looks like "Show everyone 3" or
  // "People 3". We extract the first integer we see.
  const btn = page.locator(selectors.participantCountButton).first();
  if (!(await btn.isVisible().catch(() => false))) return null;
  const aria = (await btn.getAttribute("aria-label").catch(() => "")) ?? "";
  const m = aria.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function revealAndCheckInCallControls(page: Page): Promise<boolean> {
  await nudgeMeetControls(page);

  const leaveVisible = await page
    .locator(selectors.leaveCallButton)
    .first()
    .isVisible()
    .catch(() => false);
  if (leaveVisible) return true;

  const peopleVisible = await page
    .locator(selectors.peoplePanelButton)
    .first()
    .isVisible()
    .catch(() => false);
  if (peopleVisible) return true;

  const captionsVisible = await page
    .locator(selectors.captionsToggleButton)
    .first()
    .isVisible()
    .catch(() => false);
  return captionsVisible;
}

async function nudgeMeetControls(page: Page): Promise<void> {
  await page.mouse.move(640, 760).catch(() => {});
  await page.waitForTimeout(80).catch(() => {});
  await page.mouse.move(640, 400).catch(() => {});
  await page.waitForTimeout(80).catch(() => {});
}

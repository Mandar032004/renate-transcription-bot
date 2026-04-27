import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.captions", level: process.env.LOG_LEVEL ?? "info" });

export interface DomCaption {
  speaker: string;
  text: string;
  tStart: number;
  tEnd: number;
}

export type CaptionSink = (c: DomCaption) => void | Promise<void>;

export interface CaptionObserverHandle {
  stop(): Promise<void>;
  received(): number;
}

export async function attachCaptionObserver(
  page: Page,
  sink: CaptionSink
): Promise<CaptionObserverHandle> {
  let count = 0;
  let dumpedFirstHtml = false;

  await page.exposeBinding("__renatePushCaption", async (_src, payload) => {
    try {
      const c = payload as DomCaption;
      if (!c || !c.text) return;
      count++;
      await sink(c);
    } catch (err) {
      log.error({ err }, "caption sink failed");
    }
  });

  await page.exposeBinding("__renateDumpFirstCaptionDom", async (_src, payload) => {
    if (dumpedFirstHtml) return;
    dumpedFirstHtml = true;
    log.info({ firstCaptionDom: String(payload) }, "first-caption-dom");
  });

  await enableCaptions(page);

  await page.evaluate(
    ({ regionSel, speakerBadgeSel, textNodeSel }) => {
      // Dedup per DOM row, not per speaker. Meet keeps old rows in the panel
      // for many seconds; a speaker-keyed dedup made both rows "look new" to
      // each other on every mutation, and collapsed their tStart timestamps
      // onto one — which in turn caused Q1's row to clobber Q2's text in
      // the accumulator.
      const seenByRow = new WeakMap<
        Element,
        { text: string; firstAt: number; speaker: string }
      >();
      let sentFirstHtml = false;

      function findRegion(): Element | null {
        for (const sel of regionSel.split(",").map((s: string) => s.trim())) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        return null;
      }

      /**
       * Structural row finder: any ancestor (inside the captions region)
       * that contains BOTH a speaker badge AND a text body. This avoids
       * hard-coding Meet's obfuscated class names like "nMcdL" — those
       * change regularly — and also avoids accidentally treating the
       * "Jump to bottom" button as a row.
       */
      function findRows(region: Element): Element[] {
        const badges = Array.from(region.querySelectorAll(speakerBadgeSel));
        const rows: Element[] = [];
        const seenRows = new WeakSet<Element>();
        for (const badge of badges) {
          let cur: Element | null = badge.parentElement;
          while (cur && cur !== region) {
            if (cur.querySelector(textNodeSel)) {
              if (!seenRows.has(cur)) {
                seenRows.add(cur);
                rows.push(cur);
              }
              break;
            }
            cur = cur.parentElement;
          }
        }
        return rows;
      }

      function extract(row: Element): { speaker: string; text: string } | null {
        const badge = row.querySelector(speakerBadgeSel);
        const textEl = row.querySelector(textNodeSel);
        const badgeName = (badge?.textContent ?? "").trim();
        const text = (textEl?.textContent ?? "").trim();
        if (!text) return null;
        return { speaker: badgeName, text };
      }

      function emit(row: Element) {
        const extracted = extract(row);
        if (!extracted) return;

        const prev = seenByRow.get(row);
        const now = Date.now();
        if (prev && prev.text === extracted.text) return;

        // Per-row speaker carryover: lock in the badge name the first time we
        // see this row, and reuse it on subsequent updates of the *same* row.
        // Never inherit speaker from a different row — that leak let bot-self
        // captions wear the user's name and re-fire the wake word.
        const speaker = extracted.speaker || prev?.speaker || "";

        const firstAt = prev ? prev.firstAt : now;
        seenByRow.set(row, { text: extracted.text, firstAt, speaker });

        const w = window as unknown as {
          __renatePushCaption?: (c: unknown) => Promise<void>;
          __renateDumpFirstCaptionDom?: (html: string) => Promise<void>;
        };

        if (!sentFirstHtml && w.__renateDumpFirstCaptionDom) {
          sentFirstHtml = true;
          try { void w.__renateDumpFirstCaptionDom(row.outerHTML.slice(0, 8000)); } catch {}
        }

        if (w.__renatePushCaption) {
          void w.__renatePushCaption({
            speaker,
            text: extracted.text,
            tStart: firstAt,
            tEnd: now,
          });
        }
      }

      let attachedRegion: Element | null = null;
      let attachedObserver: MutationObserver | null = null;

      function emitAll(region: Element) {
        for (const row of findRows(region)) emit(row);
      }

      function attach(region: Element) {
        // Seed with whatever rows exist right now.
        emitAll(region);

        const obs = new MutationObserver(() => {
          // On any mutation inside the region, re-scan all rows. This is
          // cheap (a handful of rows) and avoids the pitfalls of trying to
          // figure out which specific row changed.
          emitAll(region);
        });
        obs.observe(region, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        attachedRegion = region;
        attachedObserver = obs;
        (window as unknown as { __renateCaptionObserver?: MutationObserver })
          .__renateCaptionObserver = obs;
      }

      function reattachIfStale() {
        const fresh = findRegion();
        const stale =
          !attachedRegion ||
          !attachedRegion.isConnected ||
          (fresh && fresh !== attachedRegion);
        if (stale) {
          if (attachedObserver) attachedObserver.disconnect();
          attachedRegion = null;
          attachedObserver = null;
          if (fresh) attach(fresh);
        }
      }

      const existing = findRegion();
      if (existing) attach(existing);

      // Continuous watchdog — re-attaches on container swap or removal.
      const poll = setInterval(reattachIfStale, 1000);
      (window as unknown as { __renateCaptionPoll?: ReturnType<typeof setInterval> })
        .__renateCaptionPoll = poll;
    },
    {
      regionSel: selectors.captionsContainer,
      speakerBadgeSel: selectors.captionSpeakerBadge,
      textNodeSel: selectors.captionTextNode,
    }
  );

  log.info("caption observer attached");

  return {
    async stop() {
      await page
        .evaluate(() => {
          const w = window as unknown as {
            __renateCaptionObserver?: MutationObserver;
            __renateCaptionPoll?: ReturnType<typeof setInterval>;
          };
          w.__renateCaptionObserver?.disconnect();
          if (w.__renateCaptionPoll) clearInterval(w.__renateCaptionPoll);
        })
        .catch(() => {});
      log.info({ count }, "caption observer stopped");
    },
    received: () => count,
  };
}

async function enableCaptions(page: Page): Promise<void> {
  // The join.ts "post-join UI" check uses the Leave-call button, which is
  // *also* rendered in Meet's lobby ("Please wait until a meeting host brings
  // you into the call"). So by the time we get here, we may still be in the
  // lobby for up to a minute or two. The captions toggle button does NOT
  // exist in the lobby DOM, so we must poll long enough to outlast host
  // admission delays, and we must first confirm we're actually in-call.
  const DEADLINE_MS = 120_000;
  const INTERVAL_MS = 2_000;
  const VERIFY_TIMEOUT_MS = 10_000;
  const deadline = Date.now() + DEADLINE_MS;

  let attempt = 0;
  let sawInCallSignal = false;
  while (Date.now() < deadline) {
    attempt++;
    if (attempt > 1) await page.waitForTimeout(INTERVAL_MS);

    await page.mouse.move(640, 400).catch(() => {});
    await page.mouse.move(640, 760).catch(() => {});
    await page.mouse.move(640, 400).catch(() => {});
    await page.waitForTimeout(400);

    // Gate: only attempt CC toggle once we see a true in-call toolbar signal.
    // The people/participants button is only rendered post-admission; its
    // presence is a reliable "we're past the lobby" marker. The CC button
    // itself would also work (it's lobby-absent too), so we accept either.
    if (!sawInCallSignal) {
      const inCall = await page
        .evaluate(
          ({ peopleSel, ccSel }) => {
            const q = (sel: string) =>
              sel.split(",").some((s) => !!document.querySelector(s.trim()));
            return q(peopleSel) || q(ccSel);
          },
          {
            peopleSel: selectors.peoplePanelButton,
            ccSel: selectors.captionsToggleButton,
          }
        )
        .catch(() => false);
      if (!inCall) {
        if (attempt === 1 || attempt % 5 === 0) {
          log.info({ attempt }, "waiting for in-call toolbar (likely in lobby)");
        }
        continue;
      }
      sawInCallSignal = true;
      log.info({ attempt }, "in-call toolbar detected; attempting captions toggle");
    }

    const candidates = await page
      .locator(selectors.captionsToggleButton)
      .elementHandles()
      .catch(() => []);

    let clicked: string | null = null;
    let alreadyOn: string | null = null;

    for (const handle of candidates) {
      const aria = ((await handle.getAttribute("aria-label").catch(() => null)) ?? "").trim();
      if (/^turn off captions$/i.test(aria)) {
        alreadyOn = aria;
        break;
      }
      if (/^turn on captions$/i.test(aria)) {
        const visible = await handle.isVisible().catch(() => false);
        if (!visible) continue;
        await handle.click({ timeout: 2_000 }).catch(() => {});
        clicked = aria;
        break;
      }
    }
    for (const h of candidates) await h.dispose().catch(() => {});

    if (alreadyOn) {
      log.info({ attempt, aria: alreadyOn }, "captions already on");
      return;
    }

    if (clicked) {
      const verified = await verifyCaptionsOn(page, VERIFY_TIMEOUT_MS);
      if (verified) {
        log.info({ attempt, aria: clicked }, "captions enabled (verified)");
        return;
      }
      log.warn({ attempt, aria: clicked }, "captions clicked but container not rendered; retrying");
      continue;
    }

    log.warn({ attempt }, "captions toggle button not found; retrying");
  }

  log.error(
    { attempts: attempt, deadlineMs: DEADLINE_MS, sawInCallSignal },
    "captions enablement FAILED: toggle not found or container never rendered"
  );

  try {
    const shotPath = "/chunks/captions-debug.png";
    await page.screenshot({ path: shotPath, fullPage: false });
    log.info({ shotPath }, "debug screenshot saved");
  } catch (err) {
    log.warn({ err }, "screenshot failed");
  }
  try {
    const labels = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button, [role='button']"))
        .map((el) => (el.getAttribute("aria-label") ?? "").trim())
        .filter((s) => s.length > 0)
        .slice(0, 40);
    });
    log.info({ labels }, "visible button aria-labels");
  } catch (err) {
    log.warn({ err }, "aria-label dump failed");
  }
}

async function verifyCaptionsOn(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const flipped = await page
      .locator(selectors.captionsToggleButton)
      .evaluateAll((els) =>
        els.some((el) => {
          const aria = (el.getAttribute("aria-label") ?? "").trim();
          return /^turn off captions$/i.test(aria);
        })
      )
      .catch(() => false);
    if (flipped) return true;

    const containerRendered = await page
      .evaluate((sel: string) => {
        for (const s of sel.split(",").map((x) => x.trim())) {
          if (document.querySelector(s)) return true;
        }
        return false;
      }, selectors.captionsContainer)
      .catch(() => false);
    if (containerRendered) return true;

    await page.waitForTimeout(250);
  }
  return false;
}

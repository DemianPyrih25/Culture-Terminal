import type { Page, TestInfo } from "@playwright/test";
import { BRIEF_SAMPLE, databaseDown, expect, expectNoSideScroll, INVENTED_BRAND, liveServer, open, test } from "./support";

// The phone check at 390 px (Part 11): two emulations in Chromium, an iPhone (Safari's user agent, 390×844,
// DPR 3, touch) and an Android phone (Chrome's user agent on a Pixel, 390×844, DPR 2.75, touch), over Home,
// a replay, an answer with every Part 11 card (the dev viewer's "part11" variant: invented entities, places
// and example.com links), a stored permalink when the database has one, /method, /trust (it redirects to
// /how-it-works), /status, /screener, /following and a brand profile. On each page: nothing scrolls sideways,
// no card text is cut with an ellipsis, and the context cards and the supply table stack and stay readable.
// Screenshots go to test-results/ only (gitignored). The WebKit engine itself is not tested here: these are
// Chromium emulations of the two phones' screens and user agents.
//
// Run: pnpm smoke --project=phone-iphone --project=phone-android (the two projects in playwright.config.ts).
// Without those projects this file still runs both emulations under any project, from test.use below.

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

export const PHONES = {
  iPhone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA },
  Android: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: ANDROID_UA },
} as const;

/** The answer with every Part 11 card: the dev viewer's synthetic site run with the "part11" variant. */
const PART11_ANSWER = "/dev/brief?job=site_selection&variant=part11";
/** The same for a brand answer: presence chips and the context cards without a map. */
const PART11_BRAND = "/dev/brief?job=market_selection&variant=part11";

/**
 * Text cut with an ellipsis inside the page's main column: an element whose computed text-overflow is
 * ellipsis and whose content is wider than its box. Returns a short description of each.
 */
async function clippedText(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const out = [];
    const main = document.querySelector("main") || document.body;
    for (const el of main.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (style.textOverflow !== "ellipsis") continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push((el.tagName + ": " + (el.textContent || "").trim()).slice(0, 120));
    }
    return out;
  })()`);
}

/** Two boxes are stacked: the second starts below the first one's bottom (cards side by side would share a row). */
async function stacked(page: Page, first: string, second: string): Promise<boolean> {
  const a = await page.locator(first).first().boundingBox();
  const b = await page.locator(second).first().boundingBox();
  if (!a || !b) return false;
  return b.y >= a.y + a.height - 1;
}

async function phoneShot(page: Page, testInfo: TestInfo, device: string, name: string): Promise<void> {
  const path = testInfo.outputPath(`${device.toLowerCase()}-${name}.png`);
  await page.screenshot({ path, fullPage: true, caret: "initial" });
  await testInfo.attach(`${device}-${name}`, { path, contentType: "image/png" });
}

async function checkPage(page: Page, testInfo: TestInfo, device: string, name: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expectNoSideScroll(page);
  expect(await clippedText(page), "card text cut with an ellipsis").toEqual([]);
  await phoneShot(page, testInfo, device, name);
}

for (const [device, use] of Object.entries(PHONES)) {
  test.describe(`${device} at 390 px`, () => {
    test.use(use);

    for (const [name, path] of [
      ["home", "/"],
      ["method", "/method"],
      ["trust", "/trust"],
      ["status", "/status"],
      ["screener", "/screener"],
      ["following", "/following"],
    ] as const) {
      test(`${name} fits`, async ({ page }, testInfo) => {
        await open(page, path);
        await checkPage(page, testInfo, device, name);
      });
    }

    test("a replay fits while it plays and when it ends", async ({ page }, testInfo) => {
      await open(page, `${BRIEF_SAMPLE}&replay=1`);
      await expect(page.locator("[data-working], [data-verdict]").first()).toBeVisible();
      await expectNoSideScroll(page);
      await phoneShot(page, testInfo, device, "replay");
    });

    test("an answer with the context cards, the area table and the supply table stacks and stays readable", async ({ page }, testInfo) => {
      await open(page, PART11_ANSWER);
      await expect(page.locator("[data-verdict]").first()).toBeVisible();
      await checkPage(page, testInfo, device, "answer-part11");
      // The two context cards stack on a phone, each the column's width.
      const ai = page.locator('[data-context="ai"]').first();
      const web = page.locator('[data-context="web"]').first();
      await expect(ai).toBeVisible();
      await expect(web).toBeVisible();
      expect(await stacked(page, '[data-context="ai"]', '[data-context="web"]'), "the context cards stack").toBe(true);
      for (const card of [ai, web, page.locator("[data-standing]").first(), page.locator("[data-supply-scope]").first()]) {
        const box = await card.boundingBox();
        expect(box?.width ?? 0, "a card fits the column").toBeLessThanOrEqual(390);
        expect(box?.width ?? 0, "a card keeps a readable width").toBeGreaterThanOrEqual(300);
      }
      // The supply rows stack one card per area; their text is at least 13 px.
      const size = await page.evaluate<number>("parseFloat(getComputedStyle(document.querySelector('[data-supply-row] dd') || document.body).fontSize)");
      expect(size).toBeGreaterThanOrEqual(13);
    });

    test("a brand answer with presence chips fits", async ({ page }, testInfo) => {
      await open(page, PART11_BRAND);
      await expect(page.locator("[data-verdict]").first()).toBeVisible();
      await checkPage(page, testInfo, device, "answer-brand-part11");
    });

    test("a stored permalink fits", async ({ page }, testInfo) => {
      const down = await databaseDown(page);
      test.skip(down !== null, down ?? "");
      const res = await page.request.get("/api/runs?limit=1");
      const body = (await res.json().catch(() => null)) as { runs?: { runId: string }[] } | null;
      const runId = body?.runs?.[0]?.runId;
      test.skip(!runId, "no stored answer to open");
      await open(page, `/r/${runId}`);
      await expect(page.locator("[data-verdict]").first()).toBeVisible();
      await checkPage(page, testInfo, device, "permalink");
    });

    test("a brand profile fits", async ({ page }, testInfo) => {
      const down = (await databaseDown(page)) ?? (await liveServer(page));
      test.skip(down !== null, down ?? "");
      await open(page, `/d/${encodeURIComponent(INVENTED_BRAND)}`);
      await checkPage(page, testInfo, device, "profile");
    });
  });
}

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { ANSWER_SAMPLE, databaseDown, expect, open, test } from "./support";

// Accessibility (the redesign's acceptance, §5.3): axe-core on every page at the desktop and the phone
// width, with no serious or critical violation. Every answer layout is checked on its synthetic job sample
// (app/dev/brief/job-runs.ts, invented entities), plus the "Not enough data" verdict, the working view's
// states (app/dev/working), the dev galleries, the How we know drawer open, an unknown URL and a profile
// (the mock DES, which needs the server's database).

const PAGES = ["/", "/ask", "/briefs", "/how-it-works", "/method", "/status", "/d"] as const;

const JOBS = [
  "brand_health",
  "head_to_head",
  "site_selection",
  "area_profile",
  "tenant_mix",
  "sponsorship",
  "market_selection",
  "audience_discovery",
] as const;

const ANSWERS = [...JOBS.map((job) => `/dev/brief?job=${job}`), "/dev/brief?job=brand_health&variant=notenough", "/dev/brief?sample=brand-health"];

const WORKING_STATES = ["start", "early", "late", "stopped", "failed", "partial", "refused", "pick", "notfound"] as const;

const DEV = ["/dev/ui", "/dev/figures", "/dev/ask", ...WORKING_STATES.map((state) => `/dev/working?state=${state}`)];

const ROUTES = [...PAGES, ...ANSWERS, ...DEV];

/** An invented name: the mock DES describes any name from its hash (no Qloo value, D29). */
const PROFILE = "/d/Juniper%20Cola";

const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

/**
 * Waits for the page's own measuring: a chart's scroll box (ScrollRegion) becomes a focusable region only
 * once the client sees it overflow, after hydration, and axe must not read it before then.
 */
async function measured(page: Page): Promise<void> {
  // A string expression, as support.ts does: the page's own document, not Node's.
  await page.waitForFunction(
    `Array.from(document.querySelectorAll(".overflow-x-auto[data-view]")).every((el) => el.scrollWidth <= el.clientWidth + 1 || el.hasAttribute("data-scrolls"))`,
  );
}

async function expectNoSeriousViolation(page: Page, label: string): Promise<void> {
  await measured(page);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(" ") ?? ""}`);
  expect(serious, label).toEqual([]);
}

for (const { name, width, height } of WIDTHS) {
  test.describe(`at ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
    });

    for (const path of ROUTES) {
      test(`${path} has no serious accessibility violation`, async ({ page }) => {
        await open(page, path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await expectNoSeriousViolation(page, `${path} at ${name}`);
      });
    }

    test("the How we know drawer has no serious accessibility violation", async ({ page }) => {
      await open(page, ANSWER_SAMPLE);
      // On phones the page head folds How we know into its menu; the key numbers' Source opens it everywhere.
      await page.getByRole("button", { name: /^Source/ }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoSeriousViolation(page, `How we know drawer at ${name}`);
    });

    test("an unknown URL shows the not-found card with no serious accessibility violation", async ({ page }) => {
      const res = await page.goto("/no-page-at-this-link");
      expect(res?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1, name: "There's no page at this link." })).toBeVisible();
      await expect(page.getByRole("link", { name: "Ask a question" })).toBeVisible();
      await expectNoSeriousViolation(page, `not found at ${name}`);
    });

    test("a profile has no serious accessibility violation", async ({ page }) => {
      const down = await databaseDown(page);
      test.skip(down !== null, down ?? "");
      await open(page, PROFILE);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectNoSeriousViolation(page, `${PROFILE} at ${name}`);
    });
  });
}

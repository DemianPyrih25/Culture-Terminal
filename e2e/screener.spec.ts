import type { Page } from "@playwright/test";
import { type Cell, COLUMN_LABELS, SCREEN_ANSWER } from "./screener-fixture";
import { expect, expectNoExamples, expectNoSideScroll, INVENTED_BRAND, liveServer, open, SCREENER_API, shot, test } from "./support";

// The brand screener (/screener, PLAN §5.5, Part 10). The page test answers the page's POST /api/screener
// in the browser with an invented ScreenerAnswer (no request reaches the server, so it runs on any server):
// the table renders with the six columns, an unavailable cell shows its reason and never a 0, and a cell
// opens the requests behind it. The API test screens an invented brand on the server itself, so it runs on a
// mock server only (support.ts liveServer) and checks the answer's own rules: every cell cites requests of
// its screen, and an unavailable cell carries no number. The spec depends on the route names only
// (packages/contracts/src/screener.ts); the page's markup is read through roles.

/** Answers the page's screens in the browser with the invented one; registered after the spend guard, so it runs first. */
async function answerScreens(page: Page): Promise<string[]> {
  const sent: string[] = [];
  await page.route(/\/api\/screener(?:\?.*)?$/, (route, req) => {
    if (req.method() !== "POST") return route.fallback();
    sent.push(req.postData() ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SCREEN_ANSWER) });
  });
  return sent;
}

test("the screener renders a screen's table, and a cell opens the requests behind it", async ({ page }, testInfo) => {
  const sent = await answerScreens(page);
  await open(page, "/screener");
  await expect(page).toHaveTitle(/ · Culture Terminal$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Nothing is screened on arrival: a screen spends Qloo calls only when asked.
  expect(sent).toEqual([]);
  await expectNoExamples(page);

  const form = page.getByRole("main").locator("form").filter({ has: page.getByRole("textbox") }).first();
  await form.getByRole("textbox").first().fill("craft soda");
  await form.getByRole("textbox").first().press("Enter");
  await expect.poll(() => sent.length, { message: "the page sent its screen" }).toBe(1);
  const body = JSON.parse(sent[0] ?? "{}") as { seed?: { by?: string } };
  expect(["tag", "brand"]).toContain(body.seed?.by);

  const table = page.getByRole("table").first();
  await expect(table).toBeVisible();
  for (const label of COLUMN_LABELS) await expect(table.getByRole("columnheader", { name: new RegExp(label, "i") }).first()).toBeVisible();
  for (const r of SCREEN_ANSWER.screen.rows) await expect(table).toContainText(r.label);
  // UNAVAILABLE is never drawn as 0: the not-measured columns show no "0" and no "0.00".
  const firstRow = table.getByRole("row").filter({ hasText: "Kestrel Tonic" });
  await expect(firstRow).not.toContainText(/(^|\s)0(\.0+)?(\s|$)/);
  await expectNoSideScroll(page);
  await shot(page, testInfo, "screener-table");

  // A scored cell opens its requests: the FIT of the first row cites Q2.
  await firstRow.getByRole("button", { name: /0\.94/ }).first().click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Q2");
  await shot(page, testInfo, "screener-request");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test.describe(() => {
  test.use({ allowScreener: true });

  test("on a mock server, a screen cites a request of its own for every cell", async ({ page }) => {
    await open(page, "/screener");
    const live = await liveServer(page);
    test.skip(live !== null, live ?? "");
    test.setTimeout(60_000);

    const screen = async (pick?: string) =>
      (await (await page.request.post(SCREENER_API, { data: { seed: { by: "brand", name: INVENTED_BRAND }, rows: 5, ...(pick ? { pick } : {}) } })).json()) as {
        kind: string;
        candidates?: { key: string }[];
        screen?: {
          rows: { cells: Record<string, Cell> }[];
          requests: { id: string }[];
          columns: { key: string }[];
          qloo: { network: number; cached: number };
        };
      };
    let answer = await screen();
    // The mock may find the name more than once; the reader picks, so the test picks the first.
    if (answer.kind === "pick" && answer.candidates?.[0]) answer = await screen(answer.candidates[0].key);
    expect(answer.kind, JSON.stringify(answer).slice(0, 300)).toBe("ok");
    const result = answer.screen!;
    expect(result.columns.map((c) => c.key)).toEqual(["fit", "distinctiveness", "next_gen_tilt", "metro_breadth", "popularity", "under_the_radar"]);
    expect(result.rows.length).toBeGreaterThan(0);
    const ids = new Set(result.requests.map((q) => q.id));
    for (const r of result.rows) {
      for (const [column, cell] of Object.entries(r.cells)) {
        for (const id of cell.requestIds) expect(ids.has(id), `${column} cites ${id}`).toBe(true);
        if (cell.status === "ok") expect(cell.requestIds.length, `${column} names its requests`).toBeGreaterThan(0);
        else expect(cell.value, `${column} unavailable with a number`).toBeNull();
      }
    }
    // §5.5's call plan: at most 10 calls without the map.
    expect(result.qloo.network + result.qloo.cached).toBeLessThanOrEqual(10);
  });
});

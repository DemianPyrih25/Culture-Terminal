// /status rendered from a fake reading: noindex, the answer first, the five sections with their rows,
// meters, tags and outcome strips, and nothing that names a question, an entity or a request id.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANARY_API_KEY, CANARY_ENTITY, CANARY_QUESTION, CANARY_REQUEST_ID, decision, statusReport } from "./fixtures";

const status = vi.hoisted(() => ({ current: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../server/status", () => ({ currentStatus: status.current }));

const { default: StatusPage, metadata } = await import("../../app/status/page");

afterEach(() => {
  status.current.mockReset();
});

async function render(report = statusReport()): Promise<string> {
  status.current.mockResolvedValue(report);
  const html = renderToStaticMarkup(await StatusPage());
  // ARIA: a meter needs a value; an empty track is drawn as an image instead.
  expect(html.match(/<[^>]*role="meter"[^>]*>/g)?.filter((tag) => !tag.includes("aria-valuenow=")) ?? []).toEqual([]);
  return html;
}

describe("/status", () => {
  it("is kept out of search results", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Status · Culture Terminal");
  });

  it("renders the chrome, the heading, the answer and the five sections", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Main"');
    expect(html).toMatch(/<h1[^>]*>Status<\/h1>/);
    expect(html).toContain("Read 12:00:00 UTC");
    expect(html).toContain('href="/status"');
    expect(html).toMatch(/data-live-state="live"[^>]*>Live analysis is on: Sonnet 5.5 writes each brief\.<\/p>/);
    for (const [id, title] of [
      ["mode", "Mode"],
      ["spend", "LLM spend"],
      ["runs", "Runs"],
      ["qloo", "Qloo"],
      ["system", "System"],
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
      expect(html).toMatch(new RegExp(`<h2[^>]*>.*?<span class="text-ink">${title}</span></h2>`));
    }
    // The status line carries today's Qloo requests from the same reading.
    expect(html).toContain("Qloo 120 / 1,900 req today");
  });

  it("shows each lane's mode and every breaker with its state", async () => {
    const html = await render();
    expect((html.match(/data-state="live"/g) ?? []).length).toBe(2);
    expect((html.match(/data-breaker="/g) ?? []).length).toBe(9);
    expect(html).toContain("$0.12 today · public economy at $0.49, paused at $0.79");
    expect(html).toContain('data-state="clear"');
  });

  it("draws the usage meters against their caps, with the thresholds as ticks", async () => {
    const html = await render();
    expect(html).toContain('aria-label="LLM spend today against the public lane&#x27;s budget"');
    expect(html).toContain('aria-valuetext="$0.12 of $0.84"');
    expect(html).toContain('data-tick="Economy from $0.49"');
    expect(html).toContain('data-tick="Paused from $0.79"');
    expect(html).toContain('aria-valuetext="4 of 20"');
    expect(html).toContain('aria-valuetext="75%"');
    expect(html).toContain('data-tick="Replay only below the floor"');
  });

  it("shows the latest runs as status cells and counts, newest first", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Last 20 live runs, newest first: 3 completed · 1 incomplete · 1 failed"');
    expect((html.match(/data-status="/g) ?? []).length).toBe(40);
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-status="empty"');
  });

  it("says what stops live analysis and marks tripped breakers", async () => {
    const base = statusReport();
    const message = "Live analysis is paused: this month's Qloo quota is at its floor.";
    const html = await render(
      statusReport({
        live: { state: "paused", blocks: ["replay_only"], message },
        mode: { ...base.mode, lanes: { public: decision("public", "replay_only", { reason: "this month's Qloo quota is at its floor" }), judge: decision("judge", "replay_only") } },
        breakers: base.breakers.map((b) => (b.key === "qloo_floor" ? { ...b, level: "tripped" as const } : b)),
      }),
    );
    expect(html).toContain('data-live-state="paused"');
    expect(html).toContain("Showcases, replays and cached answers still work.");
    expect((html.match(/data-state="replay_only"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-state="tripped"[^>]*>.*?Tripped/);
  });

  it("renders a reading taken with the database down", async () => {
    const base = statusReport();
    const html = await render(
      statusReport({
        db: { ok: false, latencyMs: null },
        live: { state: "unavailable", blocks: ["no_database"], message: null },
        mode: { ...base.mode, lanes: null },
        llm: { ...base.llm, todayUsd: null, laneUsd: { public: null, judge: null } },
        runs: { ...base.runs, lanes: { public: { lastHour: null, hourlyCap: 20 }, judge: { lastHour: null, hourlyCap: 20 } }, recent: { live: null, test: null } },
        qloo: { configured: false, disabled: false },
      }),
    );
    expect(html).toContain("The database is unreachable");
    expect(html).toContain("Unreachable");
    expect(html).toContain("The breakers could not be read");
    expect(html).toContain("Not configured: live Qloo needs a key");
    expect(html).toMatch(/<span role="img" aria-label="Public runs, last hour: not read"/);
    expect(html).toMatch(/<span role="img" aria-label="LLM spend today against the public lane&#x27;s budget: not read"/);
    expect(html).not.toContain('data-strip="runs"');
  });

  it("names an empty cache meter for what is missing", async () => {
    const base = statusReport();
    const q = base.qloo as Extract<typeof base.qloo, { configured: true }>;
    const html = await render(statusReport({ qloo: { ...q, cache: { total: 0, served: 0, sampled: false } } }));
    expect(html).toMatch(/<span role="img" aria-label="Qloo cache hit rate today: no calls yet today"/);
    expect(html).toContain("No calls yet today");
  });

  it("never shows a lane as live on a server that takes no live run", async () => {
    const html = await render(statusReport({ live: { state: "unavailable", blocks: ["no_anthropic"], message: null } }));
    expect(html).toContain("this server has no Anthropic API key");
    expect(html).not.toContain("Sonnet 5.5 writes each brief");
    expect(html).not.toContain('data-state="live"');
    expect((html.match(/data-state="unavailable"/g) ?? []).length).toBe(2);
    expect(html).toContain("Live by the breakers · this server takes no live runs");
  });

  it("shows a rejected Qloo key as a warning, not a share of a budget", async () => {
    const base = statusReport();
    const q = base.qloo as Extract<typeof base.qloo, { configured: true }>;
    const html = await render(
      statusReport({
        qloo: { ...q, authErrors: 1 },
        breakers: base.breakers.map((b) => (b.key === "qloo_auth" ? { ...b, level: "warn" as const } : b)),
      }),
    );
    expect(html).toMatch(/data-state="warn"[^>]*>.*?Warning/);
    expect(html).not.toContain("Past 80%");
    expect(html).toContain("The Qloo key was rejected 1 time in a row");
  });

  it("shows the market locality pins by market id and count: complete, partial, missing, malformed and not read", async () => {
    const required = ["nashville", "austin"] as const;
    expect(await render()).toMatch(/data-localities="complete"[^>]*>.*?2 of 2 pinned.*?· 2 markets in all/);
    const partial = await render(statusReport({ localities: { state: "partial", required: [...required], missing: ["austin"], pinned: 1 } }));
    expect(partial).toContain('data-localities="partial"');
    expect(partial).toContain("1 of 2 pinned");
    expect(partial).toContain("not pinned: austin");
    expect(partial).toMatch(/data-state="warn"[^>]*>.*?Warning/);
    const missing = await render(statusReport({ localities: { state: "missing", required: [...required], missing: [...required], pinned: 0 } }));
    expect(missing).toContain('data-localities="missing"');
    expect(missing).toContain("not pinned: nashville, austin");
    expect(missing).toMatch(/data-state="tripped"[^>]*>.*?Tripped/);
    const malformed = await render(statusReport({ localities: { state: "malformed", required: [...required], missing: [...required], pinned: 0 } }));
    expect(malformed).toContain("every locality lookup fails");
    expect(malformed).toMatch(/data-state="tripped"[^>]*>.*?Tripped/);
    const unread = await render(statusReport({ localities: null }));
    expect(unread).not.toContain("data-localities");
    expect(unread).toMatch(/Market localities<\/dt>.*?Not read/);
  });

  it("does not promise migration retries it cannot see", async () => {
    const html = await render(statusReport({ migrations: { state: "pending", journal: null } }));
    expect(html).toContain("Pending: not applied by this server; see the startup log");
    expect(html).not.toMatch(/retrying/i);
  });

  it("prints only what it names: a question, entity, request id or key in a reading stays off the page", async () => {
    // Canaries in fields the report type does not declare: the page must print fields, not objects.
    const extra = { question: CANARY_QUESTION, entity: CANARY_ENTITY, requestId: CANARY_REQUEST_ID, apiKey: CANARY_API_KEY };
    const base = statusReport();
    const report = {
      ...base,
      ...extra,
      mode: { ...base.mode, stored: { ...base.mode.stored, ...extra }, lanes: { public: { ...decision("public"), ...extra }, judge: decision("judge") } },
      llm: { ...base.llm, ...extra },
      runs: { ...base.runs, ...extra },
      qloo: { ...base.qloo, ...extra },
    };
    const html = await render(report);
    for (const canary of Object.values(extra)) expect(html).not.toContain(canary);
    expect(html).toContain("never shown");
  });
});

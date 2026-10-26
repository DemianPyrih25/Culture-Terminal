import { describe, expect, it, vi } from "vitest";
import {
  initialRunState,
  reduceRunEvents,
  stampEvent,
  type EventInput,
  type Intent,
  type RunEvent,
  type RunState,
} from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { buildBriefModel, draftNumbers, stageStrip, traceNote, type StageState } from "../../lib/brief";
import { endedAs, FAKE_RUN, FAKE_STARTED_AT, fakeRunEvents, fixtureReport, fullRunInputs, statesAlong, upTo, upToCall } from "./support";

vi.mock("server-only", () => ({}));

const events = fakeRunEvents();
const at = (state: RunState, extraMs = 0) => Date.parse(state.updatedAt ?? new Date(FAKE_STARTED_AT).toISOString()) + extraMs;
const stateAfter = (evs: readonly RunEvent[]) => reduceRunEvents(FAKE_RUN, evs);
const live = (evs: readonly RunEvent[], extraMs = 0) => {
  const state = stateAfter(evs);
  return buildBriefModel(state, at(state, extraMs));
};

/** The test run's tool calls: the opening scan (its Substitution Map first), then the plan's name-matching step and the ANALYST's pivot. */
const SCAN = "scan-1";
const PIVOT = "toolu_sample_pivot";
/** The opening scan's estimated calls: the Substitution Map, Audience DNA and travel taste together. */
const SCAN_CALLS = events.reduce((n, e) => n + (e.type === "tool.start" && e.phase === "scan" ? (e.estimatedCalls ?? 0) : 0), 0);
/** Where the last scan tool ends: the scan's band is full from there. */
const SCAN_DONE = events.findLastIndex((e) => e.type === "tool.end" && e.toolCallId.startsWith("scan-"));

const RANK: Record<StageState, number> = { queued: 0, active: 1, idle: 1, done: 2, failed: 2 };

describe("live brief: the stage strip", () => {
  const states = statesAlong(FAKE_RUN, events);
  const strips = states.map((s) => stageStrip(s));
  const text = (i: number) => strips[i]?.map((s) => s.text).join(" · ");
  const indexOf = (type: RunEvent["type"], nth = 1) => upTo(events, type, nth).length - 1;

  it("follows the event order", () => {
    expect(text(indexOf("run.created"))).toBe("Clerk reading · Analyst queued · Quant queued · Checker queued");
    expect(text(indexOf("clerk"))).toBe("Clerk ✓ · Analyst queued · Quant queued · Checker queued");
    expect(text(indexOf("resolve"))).toBe("Clerk ✓ · Analyst planning · Quant queued · Checker queued");
    expect(text(indexOf("tool.start"))).toBe("Clerk ✓ · Analyst planning · Quant computing · Checker queued");
    // Quant computes while any scan tool runs, and waits once the last of them ends.
    expect(text(indexOf("tool.end"))).toBe("Clerk ✓ · Analyst planning · Quant computing · Checker queued");
    expect(text(SCAN_DONE)).toBe("Clerk ✓ · Analyst planning · Quant waiting · Checker queued");
    expect(text(indexOf("plan"))).toBe("Clerk ✓ · Analyst writing · Quant waiting · Checker queued");
    expect(text(events.findIndex((e) => e.type === "tool.start" && e.phase !== "scan"))).toBe("Clerk ✓ · Analyst writing · Quant computing · Checker queued");
    expect(text(indexOf("report.draft"))).toBe("Clerk ✓ · Analyst drafted · Quant ✓ · Checker checking");
    expect(text(indexOf("validation"))).toBe("Clerk ✓ · Analyst ✓ · Quant ✓ · Checker ✓");
    expect(text(states.length - 1)).toBe("Clerk ✓ · Analyst ✓ · Quant ✓ · Checker ✓");
  });

  it("never moves a role backwards", () => {
    for (const role of ["clerk", "analyst", "checker"] as const) {
      const ranks = strips.map((strip) => RANK[strip.find((s) => s.role === role)?.state ?? "queued"]);
      for (let i = 1; i < ranks.length; i++) expect(ranks[i], `${role} at event ${i + 1}`).toBeGreaterThanOrEqual(ranks[i - 1] ?? 0);
    }
    // Quant idles between tools, but never returns to the queue and is done only once the draft is in.
    const quant = strips.map((strip) => strip.find((s) => s.role === "quant")?.state);
    const started = quant.findIndex((s) => s !== "queued");
    expect(quant.slice(started)).not.toContain("queued");
    expect(quant.findIndex((s) => s === "done")).toBe(indexOf("report.draft"));
  });

  it("marks what was running as stopped when a run ends early", () => {
    expect(stageStrip(stateAfter(endedAs(upTo(events, "tool.start"), "failed", "llm_error"))).map((s) => s.text)).toEqual([
      "Clerk ✓",
      "Analyst stopped",
      "Quant stopped",
      "Checker not run",
    ]);
  });
});

describe("live brief: progress, meters and incoming requests", () => {
  const states = statesAlong(FAKE_RUN, events);
  const lives = states.map((s) => buildBriefModel(s, at(s)).live);
  const indexOf = (type: RunEvent["type"], nth = 1) => upTo(events, type, nth).length - 1;
  const lastIndexOf = (type: RunEvent["type"]) => events.findLastIndex((e) => e.type === type);

  it("counts sources without an estimate before the plan, fills the scan's band and shows the clock", () => {
    const model = live(upToCall(events, SCAN, 2), 4000);
    expect(model.mode).toBe("live");
    // The name search before the scan, plus 2 of the scan's estimated calls (its three tools together).
    expect(SCAN_CALLS).toBe(8);
    expect(model.live?.progress).toMatchObject({ label: "Gathering evidence", sourcesIn: 3, sourcesExpected: null, count: "· 3 sources" });
    expect(model.live?.progress.fraction).toBeCloseTo(0.1 + 0.15 * (2 / SCAN_CALLS));
    expect(model.live?.progress.clock).toMatch(/^\d\d:\d\d$/);
    expect(model.live?.since).toBe("Being written · since 09:12:00");
    expect(model.live?.cancellable).toBe(true);
    expect(model.header.footer).toBe("Being written · since 09:12:00");
  });

  it("moves the bar forward stage by stage and never back", () => {
    const fractions = lives.map((l) => l?.progress.fraction ?? 1);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i], `after event ${i + 1} (${events[i]?.type})`).toBeGreaterThanOrEqual(fractions[i - 1] ?? 0);
    const fractionAfter = (i: number) => lives[i]?.progress.fraction;
    expect(fractionAfter(indexOf("clerk"))).toBe(0.05);
    expect(fractionAfter(indexOf("resolve"))).toBe(0.1);
    expect(fractionAfter(SCAN_DONE)).toBeCloseTo(0.25);
    expect(fractionAfter(indexOf("plan"))).toBe(0.3);
    expect(fractionAfter(lastIndexOf("tool.end"))).toBeCloseTo(0.75);
    expect(fractionAfter(indexOf("report.draft"))).toBe(0.85);
    expect(fractionAfter(indexOf("validation"))).toBe(0.95);
    expect(fractionAfter(indexOf("report.final"))).toBe(1);
    // Before the plan nothing estimates more than what arrived, so no state stands at 95% early.
    expect(Math.max(...fractions.slice(0, indexOf("plan")))).toBeLessThanOrEqual(0.25);
  });

  it("keeps a band from moving back when a tool of it starts late", () => {
    const state = stateAfter(upToCall(events, PIVOT, 1));
    const pivot = state.toolCalls.find((t) => t.toolCallId === PIVOT);
    if (!pivot) throw new Error("no pivot in the test run");
    expect(pivot.phase).toBe("followup");
    const before = buildBriefModel(state, at(state)).live?.progress.fraction ?? 0;
    expect(before).toBeGreaterThan(0.55);
    // Another follow-up of 5 calls starting now makes the calls already in a smaller share of the band.
    const seq = state.lastSeq + 1;
    const late: RunState = { ...state, lastSeq: seq, toolCalls: [...state.toolCalls, { ...pivot, toolCallId: "late-1", qlooCallIds: [], startedSeq: seq }] };
    expect(buildBriefModel(late, at(late)).live?.progress.fraction).toBeCloseTo(before);
  });

  it("estimates sources from the plan on, and stops estimating once no more calls can come", () => {
    const counts = lives.map((l) => [l?.progress.sourcesIn, l?.progress.sourcesExpected, l?.progress.count] as const);
    const plan = indexOf("plan");
    for (const [n, expected, count] of counts.slice(0, plan)) {
      expect(expected).toBeNull();
      expect(count).toBe(`· ${n} ${n === 1 ? "source" : "sources"}`);
    }
    const atPlan = states[plan] as RunState;
    const planned = atPlan.plan?.estimates.reduce((sum, e) => sum + e.calls, 0) ?? 0;
    expect(counts[plan]).toEqual([atPlan.qloo.chips.length, atPlan.qloo.chips.length + planned, `· ${atPlan.qloo.chips.length} of ~${atPlan.qloo.chips.length + planned} sources`]);
    // While calls can still come the estimate holds or grows, and never reads less than what arrived.
    const lastTool = lastIndexOf("tool.end");
    const estimates = counts.slice(plan, lastTool).map(([n, expected]) => {
      expect(expected).not.toBeNull();
      expect(expected ?? 0).toBeGreaterThanOrEqual(n ?? 0);
      return expected ?? 0;
    });
    expect(estimates).toEqual([...estimates].sort((a, b) => a - b));
    // The follow-ups are done: only the answer is left, and every call is in.
    const chips = states.at(-1)?.qloo.chips.length ?? 0;
    expect(estimates.at(-1)).toBe(chips);
    expect(counts[lastTool]).toEqual([chips, null, `· ${chips} sources`]);
  });

  it("writes the answer only after the follow-ups end, never while sources still arrive", () => {
    const labels = lives.map((l) => l?.progress.label ?? "ended");
    const firstWriting = labels.indexOf("Writing the answer");
    expect(firstWriting).toBe(lastIndexOf("tool.end"));
    expect(firstWriting).toBeGreaterThan(lastIndexOf("qloo"));
    // Between wave 1 and the follow-ups the ANALYST may still ask for more: that wait is gathering.
    const phases = new Map(states.at(-1)?.toolCalls.map((t) => [t.toolCallId, t.phase]));
    const wave1End = events.findIndex((e) => e.type === "tool.end" && phases.get(e.toolCallId) === "wave1");
    const pivot = indexOf("pivot");
    expect(pivot - wave1End).toBeGreaterThan(1);
    expect(new Set(labels.slice(wave1End, pivot))).toEqual(new Set(["Gathering evidence"]));
    expect(new Set(labels.slice(firstWriting, indexOf("report.draft")))).toEqual(new Set(["Writing the answer"]));
  });

  it("meters requests, model cost and time against the run's limits", () => {
    const state = stateAfter(upToCall(events, SCAN, 4));
    const model = buildBriefModel(state, Date.parse(state.createdAt ?? "") + 21_000);
    // Network calls only: the reused and cached ones cost no request.
    expect(model.live?.meters.requests).toMatchObject({ label: "Requests", used: state.qloo.network, limit: 40, text: `${state.qloo.network} / 40`, warn: false });
    expect(state.qloo.network).toBeLessThan(state.qloo.chips.length);
    expect(model.live?.meters.cost).toMatchObject({ label: "Model cost", text: "$0.00 / $0.60", warn: false });
    expect(model.live?.meters.time).toMatchObject({ label: "Time", text: "00:21 / 180 s", limit: 180, warn: false });
    expect(model.live?.meters.time.fraction).toBeCloseTo(21 / 180);
  });

  it("shows the request in flight, the queue behind it and what just arrived", () => {
    const model = live(upToCall(events, SCAN, 2), 4000);
    const rows = model.live?.incoming ?? [];
    // Newest tool first: each scan tool in flight, with the rest of its estimate queued behind it.
    expect(rows.map((r) => [r.toolCallId, r.state])).toEqual([
      ["scan-3", "fetching"],
      ["scan-2", "fetching"],
      ["scan-2", "queued"],
      [SCAN, "fetching"],
      [SCAN, "queued"],
      [SCAN, "received"],
    ]);
    // A tool with no call in yet names no endpoint.
    expect(rows[0]).toMatchObject({ text: "Qloo · travel data ← R1 Juniper Cola · fetching" });
    expect(rows[3]).toMatchObject({ text: "Qloo /v2/insights · similarity data ← R1 Juniper Cola · fetching", trace: "fetching · 00:04" });
    expect(rows[4]).toMatchObject({ trace: "2 more queued", count: 2 });
    // A call that arrived is complete: no in-flight word, even while its tool still runs.
    expect(rows[5]).toMatchObject({ text: "Qloo /v2/insights · brand ← R1 Juniper Cola", sourceIndex: 2 });
    expect(rows[5]?.trace).toMatch(/^req .{4}….{4} · 20 rows · reused from #[0-9A-Z]{4}$/);
    for (const r of rows.filter((r) => r.state !== "fetching")) expect(r.text).not.toMatch(/receiving|fetching/);
  });

  it("counts rows in the reader's words: 1 row, not 1 rows", () => {
    const state = stateAfter(upToCall(events, SCAN, 2));
    const rows = (n: number) => {
      const chips = state.qloo.chips.map((c, i) => (i === 2 ? { ...c, rows: n } : c));
      const model = buildBriefModel({ ...state, qloo: { ...state.qloo, chips } }, at(state, 4000));
      return model.live?.incoming.find((r) => r.sourceIndex === 2)?.trace ?? "missing";
    };
    expect(rows(1)).toMatch(/^req .{4}….{4} · 1 row · /);
    expect(rows(0)).toMatch(/ · 0 rows · /);
    expect(rows(2)).toMatch(/ · 2 rows · /);
  });
});

describe("live brief: priors, key figures and the trace note", () => {
  it("holds the priors awaiting data, then awaiting the check", () => {
    const atPlan = live(upTo(events, "plan"));
    const n = atPlan.priors.items.length;
    expect(n).toBeGreaterThan(1);
    expect(atPlan.priors.items.map((p) => [p.state, p.word, p.measured])).toEqual(Array.from({ length: n }, () => ["awaiting_data", "AWAITING DATA", null]));
    expect(atPlan.priors.items[0]?.progress).toMatch(/^Written before data · \d\d:\d\d:\d\d · waiting on similarity data$/);
    expect(atPlan.priors.tally).toBeNull();
    expect(atPlan.priors.kicker).toBe(`Four priors, written before any data · ${atPlan.priors.lockedAt}`);

    expect(live(upToCall(events, PIVOT, 2)).priors.items[0]?.progress).toMatch(/similarity data arriving$/);
    const drafted = live(upTo(events, "report.draft"));
    expect(drafted.priors.items[0]).toMatchObject({ state: "awaiting_check", word: "AWAITING CHECK", measured: null });
    expect(drafted.priors.items[0]?.progress).toMatch(/similarity data in$/);
  });

  it("fills key figures as their metrics arrive and keeps the rest pending, never as 0", () => {
    const early = live(upToCall(events, SCAN, 2));
    expect(early.evidence.keyFigures.map((k) => [k.state, k.label, k.pendingNote])).toEqual([
      ["pending", "Nearest audience", "computing · QUANT"],
      ["pending", "Distinctiveness", "computing · QUANT"],
      ["pending", "Youth tilt", "waiting on share data"],
      ["pending", "Metros won", "waiting on share data"],
    ]);
    for (const k of early.evidence.keyFigures) expect(k.metric).toBeNull();
    expect(early.evidence.aside).toBe("0 of 4 key figures in · exhibits drafted last");

    // The first similarity, distinctiveness and youth metrics fill their slots, matched by formula id.
    const state = stateAfter(upTo(events, "plan"));
    const later = buildBriefModel(state, at(state));
    const first = (formula: string) => Object.values(state.metrics).find((m) => m.formulaId === formula);
    expect(later.evidence.keyFigures.map((k) => [k.state, k.key, k.metric?.text ?? null])).toEqual([
      ["ready", first("subs.similarity")?.id, first("subs.similarity")?.display],
      ["ready", first("subs.distinctiveness")?.id, first("subs.distinctiveness")?.display],
      ["ready", first("dna.youth_index")?.id, first("dna.youth_index")?.display],
      ["pending", "pending-3", null],
    ]);
    // An arrived figure is named as the finished brief names it: a youth index is not the slot's share
    // tilt. The metric's own label is the inspector's.
    expect(later.evidence.keyFigures.map((k) => k.label)).toEqual(["Nearest audience", "Distinctiveness", "Youth index", "Metros won"]);
    expect(later.evidence.keyFigures[0]?.metric?.label).toBe(first("subs.similarity")?.label);
    expect(later.evidence.keyFigures.map((k) => k.comparator)).toEqual(["with Granite Outfitters", "vs peers", "0 = average", null]);
    expect(later.evidence.aside).toBe("3 of 4 key figures in · exhibits drafted last");
  });

  it("names a lift by its neighbourhood once it arrives, as the finished brief does", () => {
    const site = jobRunEvents("site_selection");
    const run = site[0]?.runId ?? "dev-site";
    const model = (evs: readonly RunEvent[]) => {
      const state = reduceRunEvents(run, evs);
      return buildBriefModel(state, Date.parse(state.updatedAt ?? "") + 1000);
    };
    const labels = (evs: readonly RunEvent[]) => model(evs).evidence.keyFigures.map((k) => [k.state, k.label]);
    // Before the map: the slots hold their places under their own labels.
    const start = site.findIndex((e) => e.type === "tool.start" && e.tool === "geo_lift");
    expect(labels(site.slice(0, start + 1)).slice(0, 3)).toEqual([
      ["pending", "Area lift"],
      ["pending", "Area lift"],
      ["pending", "Area lift"],
    ]);
    // Once its metrics are in, each lift names its neighbourhood, live and final alike.
    const drafted = labels(site.slice(0, site.findIndex((e) => e.type === "report.final")));
    expect(drafted.slice(0, 3)).toEqual([
      ["ready", "East Cesar Chavez"],
      ["ready", "Holly"],
      ["ready", "Central East Austin"],
    ]);
    expect(model(site).evidence.keyFigures.slice(0, 3).map((k) => [k.state, k.label])).toEqual(drafted.slice(0, 3));
  });

  it("matches key-figure slots on exact metric keys only", () => {
    const state = stateAfter(upTo(events, "plan"));
    const bare = Object.fromEntries(Object.entries(state.metrics).map(([id, m]) => [id, { ...m, key: m.key.split(".").at(-1) ?? m.key }]));
    const model = buildBriefModel({ ...state, metrics: bare }, at(state));
    expect(model.evidence.keyFigures.every((k) => k.state === "pending")).toBe(true);
  });

  it("numbers live footnotes in arrival order and renumbers once at report.final", () => {
    const state = stateAfter(upTo(events, "report.draft"));
    const model = buildBriefModel(state, at(state));
    const seqOf = (key: string) => {
      const entry = [...state.timeline].reverse().find((t) => t.key === key && (t.type === "metric" || t.type === "dataset.ready"));
      return entry?.seq ?? Number.NaN;
    };
    const seqs = model.footnotes.map((f) => seqOf(f.key));
    expect(seqs.every(Number.isFinite)).toBe(true);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(model.footnotes.map((f) => f.n)).toEqual(model.footnotes.map((_, i) => i + 1));
    // Every dataset so far is a live figure, in arrival order.
    const datasets = Object.values(state.datasets).map((d) => d.id);
    expect(datasets.length).toBeGreaterThan(1);
    expect(model.footnotes.filter((f) => f.kind === "figure").map((f) => f.key)).toEqual(datasets);
    // Live figures are provisional: title from the dataset, no caption yet.
    expect(model.evidence.figures.map((f) => [f.number, f.datasetId, f.provisional, f.caption.length])).toEqual(datasets.map((id, i) => [i + 1, id, true, 0]));

    const final = buildBriefModel(stateAfter(upTo(events, "report.final")), at(state));
    expect(final.mode).toBe("final");
    expect(final.footnotes[0]?.firstCitedIn).toBe("answer");
    const figure = final.footnotes.find((f) => f.kind === "figure")?.key;
    expect(figure).toBeDefined();
    expect(final.footnotes.find((f) => f.key === figure)?.n).not.toBe(model.footnotes.find((f) => f.key === figure)?.n);
    expect(final.footnotes.map((f) => f.n)).toEqual(final.footnotes.map((_, i) => i + 1));
  });

  it("counts the numbers to trace only once a draft cites them, and counts the sources the footnotes cite", () => {
    const state = stateAfter(upTo(events, "plan"));
    const before = buildBriefModel(state, at(state));
    const cited = before.sources.items.filter((s) => s.footnotes.length > 0).length;
    // The footnotes (the key figures in and the scan's figures) cite more requests than that.
    const ready = before.evidence.keyFigures.filter((k) => k.state === "ready").length;
    expect(before.footnotes).toHaveLength(ready + Object.keys(state.datasets).length);
    expect(cited).toBeGreaterThan(before.footnotes.length);
    // Before the draft nothing says which numbers the prose will cite, so there is no count to guess.
    expect(before.trace).toEqual({
      state: "pending",
      headline: "Numbers traced after the check",
      detail: `Checker queued · ${state.qloo.chips.length} sources in, ${cited} cited`,
    });
    const headlines = statesAlong(FAKE_RUN, upTo(events, "report.draft")).map((s) => traceNote(s, 0).headline);
    expect(new Set(headlines.slice(0, -1))).toEqual(new Set(["Numbers traced after the check"]));

    // The draft's own tokens give the count, and the CHECKER then traces that many.
    const passed = live(upTo(events, "validation"));
    const [, total] = /^(\d+)\/\1 numbers traced$/.exec(passed.trace.headline) ?? [];
    expect(passed.trace.state).toBe("passed");
    const checking = live(upTo(events, "report.draft"));
    expect(checking.trace).toMatchObject({ state: "checking", headline: `0 of ~${total} numbers traced` });
    expect(checking.trace.detail).toMatch(/^Checker running · \d+ sources in, \d+ cited$/);
    expect(checking.method.checker.state).toBe("checking");
    expect(live(upTo(events, "run.created")).trace.headline).toBe("Numbers traced after the check");
  });

  it("counts a draft's numbers as the CHECKER does: every metric token, never one without a value", () => {
    const state = stateAfter(upTo(events, "report.draft"));
    const draft = state.draft;
    if (!draft) throw new Error("no draft in the test run");
    const base = draftNumbers(state);
    expect(base).toBeGreaterThan(0);
    // A repeated token counts twice; a token of a metric that arrived without a value does not count.
    const cited = new Set([...JSON.stringify(draft).matchAll(/\{\{(M\d+)\}\}/g)].map((m) => m[1]));
    const metric = Object.values(state.metrics).find((m) => m.value !== null && cited.has(m.id));
    if (!metric) throw new Error("the test run's draft cites no metric with a value");
    const twice: RunState = { ...state, draft: { ...draft, thesis: `${draft.thesis} {{${metric.id}}} and {{${metric.id}}}` } };
    expect(draftNumbers(twice)).toBe(base + 2);
    const empty: RunState = { ...twice, metrics: { ...twice.metrics, [metric.id]: { ...metric, value: null } } };
    expect(draftNumbers(empty)).toBeLessThan(base);
    expect(draftNumbers({ ...state, draft: null })).toBe(0);
  });

  it("keeps the mechanics sections dim while the brief is written", () => {
    const model = live(upToCall(events, SCAN, 2));
    expect(model.answer).toMatchObject({ state: "pending", tag: "Written last, after the check", headline: null });
    expect(model.conviction).toMatchObject({ state: "pending", aside: "Pending · computed after the check", summary: null, why: null });
    expect(model.header.conviction).toBeNull();
    expect(model.outline.filter((o) => !o.available).map((o) => o.id)).toEqual(["evidence", "risks", "method", "sources"]);
    expect(model.method.steps[0]).toMatchObject({ origin: "scan", status: "running" });
  });

  it("builds an empty brief before the first event", () => {
    const model = buildBriefModel(initialRunState("run-empty-1"), FAKE_STARTED_AT);
    expect(model.header).toMatchObject({ question: null, deskLabel: null, briefLabel: "Brief RUNE", sourceCount: 0 });
    expect(model.live?.stages.map((s) => s.text)).toEqual(["Clerk queued", "Analyst queued", "Quant queued", "Checker queued"]);
    expect(model.live?.progress.label).toBe("Reading the question");
    expect(model.terminal).toBeNull();
  });
});

describe("terminal states", () => {
  const RUN = "run-terminal-1";
  const t = (seq: number) => new Date(FAKE_STARTED_AT + seq * 1000).toISOString();
  const run = (inputs: EventInput[]) => {
    const evs = inputs.map((input, i) => stampEvent(input, { seq: i + 1, ts: t(i + 1), runId: RUN }));
    return buildBriefModel(reduceRunEvents(RUN, evs), FAKE_STARTED_AT + 60_000);
  };
  const created = fullRunInputs[0] as EventInput;
  const clerk = fullRunInputs[1] as Extract<EventInput, { type: "clerk" }>;
  const end = (status: Extract<EventInput, { type: "run.end" }>["status"], reason: string | null): EventInput => ({ type: "run.end", status, elapsedMs: 9000, reason });

  it("needs_input offers the picker candidates", () => {
    const model = run([
      created,
      clerk,
      { type: "needs_input", mention: "Marlowe Ridge", entityType: "brand", reason: "ambiguous", candidates: [{ key: "c1", name: "Marlowe Ridge", disambiguation: "Winery", popularity: 0.3 }] },
      end("needs_input", null),
    ]);
    expect(model.status).toBe("needs_input");
    expect(model.terminal).toMatchObject({ kind: "needs_input", mention: "Marlowe Ridge", reasonLabel: "Several entities share this name" });
    // The run waits for the reader; it did not stop short.
    expect(model.answer).toMatchObject({ state: "stopped", tag: "Waiting for your pick", headline: null });
    expect(model.terminal?.kind === "needs_input" && model.terminal.candidates.map((c) => c.key)).toEqual(["c1"]);
    expect(model.live).toBeNull();
  });

  it("refused names the category and the reframe", () => {
    const refused: Intent = { ...clerk.intent, safety: { allowed: false, category: "private_individual", reframe: "Group-level taste of the audience" } };
    const model = run([created, { type: "clerk", intent: refused, ms: 500 }, end("refused", "private individual")]);
    expect(model.terminal).toEqual({
      kind: "refused",
      category: "private_individual",
      categoryLabel: "Private individuals",
      reframe: "Group-level taste of the audience",
      message: "This question was refused before any data was requested: private individuals.",
    });
    expect(model.answer).toMatchObject({ state: "stopped", tag: "Question refused" });
    expect(stageStrip(reduceRunEvents(RUN, [])).length).toBe(4);
  });

  it("an ANALYST refusal after requests does not claim none were made", () => {
    const model = live(endedAs(upTo(events, "report.draft"), "refused", "financial advice"));
    expect(model.sources.items.length).toBeGreaterThan(0);
    // The test run's CLERK reframed an investment question, so the category is financial advice.
    expect(model.terminal).toMatchObject({ kind: "refused", message: "This question was refused: financial advice." });
    expect(model.answer).toMatchObject({ state: "stopped", tag: "Question refused" });
    // Before run.end, CLERK's refusal already reads as one.
    const refused: Intent = { ...clerk.intent, safety: { allowed: false, category: "political_targeting", reframe: null } };
    expect(run([created, { type: "clerk", intent: refused, ms: 500 }]).answer).toMatchObject({ state: "pending", tag: "Question refused" });
  });

  it("failed and cancelled say what happened", () => {
    const failed = run([created, clerk, { type: "error", code: "llm_error", message: "The model did not answer.", retryable: false }, end("failed", "llm_error")]);
    expect(failed.terminal).toEqual({
      kind: "failed",
      reason: "llm_error",
      errors: [{ code: "llm_error", message: "The model did not answer." }],
      message: "The run failed: llm_error.",
    });
    expect(run([created, clerk, end("cancelled", "cancelled by the user")]).terminal).toMatchObject({ kind: "cancelled" });
  });

  it("drops the live wording when a run stops without a brief: nothing is still coming", () => {
    for (const status of ["failed", "cancelled", "incomplete"] as const) {
      const model = live(endedAs(upToCall(events, PIVOT, 2), status, "stopped in the test"));
      expect(model.terminal?.kind, status).toBe(status);
      expect(model.live).toBeNull();
      expect(model.answer).toMatchObject({ state: "stopped", tag: "Not written · run stopped", headline: null });
      expect(model.conviction).toMatchObject({ state: "stopped", aside: "Not computed · run stopped", summary: null });
      expect(model.priors.items.length).toBeGreaterThan(0);
      for (const p of model.priors.items) {
        expect(p).toMatchObject({ state: "not_scored", word: "NOT SCORED", mark: "·", measured: null, progress: "Run stopped before the check" });
      }
      // Key figures that arrived stay; the rest are not measured, never 0.
      expect(model.evidence.keyFigures.map((k) => [k.state, k.pendingNote])).toEqual([
        ["ready", null],
        ["ready", null],
        ["ready", null],
        ["pending", "not measured · run stopped"],
      ]);
      expect(model.evidence.aside).toBe("3 of 4 key figures in · run stopped");
      expect(model.trace).toEqual({ state: "stopped", headline: "Not checked", detail: "Checker did not run" });
      expect(model.method.checker).toMatchObject({ state: "stopped", line: null });
      // The calls in flight stopped with the run; the plan steps it never reached did not run.
      const statuses = model.method.steps.map((s) => s.status);
      expect(statuses).not.toContain("running");
      expect(statuses).not.toContain("planned");
      expect(statuses).toContain("stopped");
      expect(statuses).toContain("not_run");
      expect(model.method.steps.flatMap((s) => s.calls.map((c) => c.status))).not.toContain("running");
    }
  });

  it("incomplete shows the INCOMPLETE badge, with or without an evidence digest", () => {
    const digest = run([
      created,
      clerk,
      { type: "report.final", report: { ...fixtureReport, runId: RUN, incomplete: true } },
      end("incomplete", "response_limit"),
    ]);
    expect(digest.mode).toBe("final");
    expect(digest.header.incomplete).toBe(true);
    expect(digest.terminal).toMatchObject({ kind: "incomplete", badge: "INCOMPLETE", reason: "response_limit" });
    expect(digest.terminal?.message).toMatch(/digest of the evidence/);
    const bare = run([created, clerk, end("incomplete", "hard_timeout")]);
    expect(bare.terminal).toMatchObject({ kind: "incomplete", badge: "INCOMPLETE" });
    expect(bare.header.incomplete).toBe(true);
  });

  it("never reports a check on an evidence digest: no CHECKER read its prose", () => {
    // What the agent's buildIncompleteReport sends: incomplete, 0/0 traced, and no validation event.
    const receipt = { ...fixtureReport.receipt, numbersTraced: { traced: 0, total: 0 } };
    const digest = run([created, clerk, { type: "report.final", report: { ...fixtureReport, runId: RUN, incomplete: true, receipt } }, end("incomplete", "hard_timeout")]);
    expect(digest.trace).toEqual({ state: "skipped", headline: "Not checked", detail: "The analysis did not finish; there is no prose to trace" });
    expect(digest.method.checker).toMatchObject({ state: "skipped", line: null, traced: null, total: null });
    // The same holds for a digest flagged incomplete whatever its receipt says.
    const flagged = run([created, clerk, { type: "report.final", report: { ...fixtureReport, runId: RUN, incomplete: true } }, end("incomplete", null)]);
    expect(flagged.trace.state).toBe("skipped");
    // A complete report the CHECKER passed still says so.
    const complete = run([created, clerk, fullRunInputs.find((i) => i.type === "validation") as EventInput, { type: "report.final", report: { ...fixtureReport, runId: RUN } }, end("completed", null)]);
    expect(complete.trace).toMatchObject({ state: "passed", headline: "3/3 numbers traced" });
  });
});

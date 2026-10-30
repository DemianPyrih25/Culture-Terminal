// The share card's data (lib/og/card.ts, mini-viz.ts): built from the brief model the permalink renders,
// so it says what the brief says, for every job's synthetic finished run and the recorded samples
// (invented entities, D29). What the card prints is read back from its drawing (OgCardImage).
import { describe, expect, it, vi } from "vitest";
import { Job, type DatasetEnvelope, type DatasetKind, type RunEvent, type RunState } from "@ct/contracts";
import { buildBriefModel } from "../../lib/brief";
import {
  buildOgCard,
  hasOgCard,
  KEY_COMPARATOR_TYPE,
  KEY_LABEL_TYPE,
  keySlotWidth,
  miniViz,
  MINI_ROWS,
  OG_FRAME,
  OG_HONESTY,
  QUESTION_MAX,
  questionText,
  textWidth,
  type MiniViz,
  type OgCard,
} from "../../lib/og";
import { sampleEvents } from "../../server/samples";
import { endedAs } from "../brief-page/support";
import { cardOf, FAKE_UUID, idsIn, imageText, jobState, stateOf } from "./support";

vi.mock("server-only", () => ({}));

const VIZ_KIND: Readonly<Record<DatasetKind, MiniViz["kind"] | null>> = {
  Bars: "rows",
  Ranked: "rows",
  Slate: "rows",
  GeoLift: "rows",
  Position: "rows",
  Matrix: "grid",
  Quadrant: "scatter",
  Slope: "lines",
  Momentum: "lines",
  Scorecard: null,
  TasteMap: null,
  Supply: null,
};

/** The trust example: a question CLERK refused before any data, ended as refused. */
function refusedState(): RunState {
  const events = sampleEvents("needs-input");
  const clerk = events.find((e) => e.type === "clerk");
  if (clerk?.type !== "clerk") throw new Error("no clerk event");
  const refusedClerk: RunEvent = { ...clerk, intent: { ...clerk.intent, safety: { allowed: false, category: "political_targeting", reframe: null } } };
  return stateOf(endedAs([events[0] as RunEvent, refusedClerk], "refused", "political targeting"));
}

/** Every string a card holds, for the id checks. */
function cardStrings(card: OgCard): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(card);
  return out;
}

/** Every 0–1 coordinate a mini viz holds. */
function coordinates(viz: MiniViz): number[] {
  switch (viz.kind) {
    case "rows":
      return [...(viz.centre === null ? [] : [viz.centre]), ...viz.rows.flatMap((r) => [...(r.bar ? [r.bar.from, r.bar.to] : []), ...r.dots.map((d) => d.at)])];
    case "grid":
      return viz.rows.flatMap((r) => r.cells.flatMap((c) => (c === null ? [] : [c])));
    case "scatter":
      return [viz.split.x, viz.split.y, ...viz.points.flatMap((p) => [p.x, p.y])];
    case "lines":
      return viz.lines.flatMap((l) => l.points.flatMap((p) => (p ? [p.x, p.y] : [])));
  }
}

describe("a showcase's card", () => {
  it.each(Job.options)("%s: the question, the signal line, the lead figure drawn small, the key figures and the receipts", (job) => {
    const state = jobState(job);
    const model = buildBriefModel(state, Date.now());
    const card = cardOf(state);
    expect(hasOgCard(model, state)).toBe(true);

    expect(card.question.text).toBe(model.header.question);
    expect(card.head).toEqual({ desk: model.header.deskLabel, job: model.header.jobLabel, brief: model.header.briefLabel, date: model.header.date });
    expect(card.signal.tag).toBe(model.header.signal?.label);
    expect(card.signal.finding).toBe(model.header.finding);
    expect(card.signal.conviction?.text).toBe(model.header.conviction?.text);
    expect(card.signal.marker).toBeNull();

    // The lead figure, drawn in its own shape, on a 0–1 frame.
    const lead = model.evidence.figures[0]!;
    expect(card.panel?.kind).toBe("figure");
    if (card.panel?.kind !== "figure") return;
    expect(card.panel.number).toBe(1);
    expect(card.panel.title).toBe(lead.title);
    expect(card.panel.viz.kind).toBe(VIZ_KIND[lead.kind]);
    for (const c of coordinates(card.panel.viz)) expect(c >= 0 && c <= 1).toBe(true);
    if (card.panel.viz.kind === "rows") expect(card.panel.viz.rows.length).toBeLessThanOrEqual(MINI_ROWS);

    // The brief's own key figures, as the strip prints them.
    const ready = model.evidence.keyFigures.filter((k) => k.state === "ready").slice(0, 2);
    expect(card.panel.keyFigures.map((k) => k.value)).toEqual(ready.map((k) => k.value));

    // The receipts: Qloo calls, numbers traced, model cost.
    const receipt = state.report!.receipt;
    expect(card.receipt).toEqual([
      model.statusLine.requests,
      `${receipt.numbersTraced.traced}/${receipt.numbersTraced.total} numbers traced`,
      `LLM $${receipt.usd.toFixed(2)}`,
    ]);
    expect(card.honesty).toBe(OG_HONESTY);

    const text = imageText(card);
    for (const s of [card.question.text, card.signal.finding!, card.signal.conviction!.text, ...card.receipt, OG_HONESTY]) expect(text).toContain(s);
  });

  it("prints the recorded brief's numbers as the brief does: 21 Qloo requests, 25/25 traced, its model cost", () => {
    const card = cardOf(stateOf(sampleEvents("brand-health")));
    expect(card.receipt).toEqual(["Qloo 21 req · 5 cached", "25/25 numbers traced", "LLM $0.10"]);
    expect(card.signal).toMatchObject({ tag: "Mixed signal", finding: "Taste island", marker: null });
    expect(card.alt).toContain("Is the Juniper Cola audience a moat or a niche?");
    expect(card.alt).toContain("Taste island");
  });

  it("marks an INCOMPLETE evidence digest and says it was not checked", () => {
    const card = cardOf(stateOf(sampleEvents("brand-health-incomplete")));
    expect(card.signal.marker).toBe("INCOMPLETE");
    expect(card.receipt[1]).toBe("Not checked");
    expect(imageText(card)).toContain("INCOMPLETE");
  });

  it("draws the trust example's refusal: no figure, the refusal and its category, no Qloo calls", () => {
    const state = refusedState();
    const model = buildBriefModel(state, Date.now());
    expect(hasOgCard(model, state)).toBe(true);
    const card = cardOf(state);
    expect(card.signal).toMatchObject({ tag: "Question refused", finding: null, conviction: null });
    expect(card.panel).toEqual({ kind: "refusal", category: "Political targeting", message: model.terminal?.message, reframe: null });
    expect(card.receipt[0]).toBe("Qloo 0 req · 0 cached");
  });

  it("has no card for a run stored without its report", () => {
    const state: RunState = { ...jobState("brand_health"), report: null };
    expect(hasOgCard(buildBriefModel(state, Date.now()), state)).toBe(false);
  });

  it("falls back to the key figures when no figure can be drawn, and uses a dataset fetched for a figure the stream did not carry", () => {
    const state = jobState("market_selection");
    const stripped: RunState = { ...state, datasets: Object.fromEntries(Object.entries(state.datasets).map(([id, d]) => [id, { ...d, data: null }])) };
    const model = buildBriefModel(stripped, Date.now());
    expect(model.evidence.figures[0]?.needsFetch).toBe(true);
    const bare = buildOgCard({ model, state: stripped });
    expect(bare.panel?.kind).toBe("key_figures");
    if (bare.panel?.kind === "key_figures") expect(bare.panel.keyFigures.length).toBe(2);

    const lead = model.evidence.figures[0]!;
    const envelope = state.datasets[lead.datasetId]?.data as DatasetEnvelope;
    const fetched = buildOgCard({ model, state: stripped, datasets: new Map([[lead.datasetId, envelope]]) });
    expect(fetched.panel?.kind === "figure" && fetched.panel.viz.kind).toBe("grid");
  });
});

describe("key figures", () => {
  const states: [string, RunState][] = [
    ...Job.options.map((job): [string, RunState] => [job, jobState(job)]),
    ["brand-health", stateOf(sampleEvents("brand-health"))],
    ["refused", refusedState()],
  ];

  it.each(states)("%s: every label and comparator fits its slot, so no CSS ellipsis cuts it mid-word", (_, state) => {
    const model = buildBriefModel(state, Date.now());
    const card = cardOf(state);
    if (card.panel?.kind !== "figure" && card.panel?.kind !== "key_figures") return;
    const width = card.panel.kind === "figure" ? keySlotWidth(card.panel.keyFigures.length) : OG_FRAME.right;
    const given = model.evidence.keyFigures.filter((k) => k.state === "ready");
    card.panel.keyFigures.forEach((k, i) => {
      expect(textWidth(k.label, KEY_LABEL_TYPE)).toBeLessThanOrEqual(width);
      // A label is the brief's own, or its head cut at a word.
      const label = given[i]!.label;
      const head = k.label.slice(0, -1);
      expect(k.label === label || (k.label.endsWith("…") && label.startsWith(head) && /[\s,;:.!?·—–-]/u.test(label.charAt(head.length)))).toBe(true);
      if (k.comparator === null) return;
      expect(textWidth(k.comparator, KEY_COMPARATOR_TYPE)).toBeLessThanOrEqual(width);
      // A comparator keeps its first " · " parts whole: no ellipsis where dropping a part was enough.
      const parts = given[i]!.comparator!.split(" · ");
      if (textWidth(parts[0]!, KEY_COMPARATOR_TYPE) <= width - 2) {
        expect(k.comparator).not.toContain("…");
        expect(given[i]!.comparator!.startsWith(k.comparator)).toBe(true);
      }
    });
  });

  it("drops a comparator's trailing part in a two-up slot, keeps a label that fits whole, cuts one that does not at a word", () => {
    const h2h = cardOf(jobState("head_to_head"));
    if (h2h.panel?.kind !== "figure") throw new Error("no figure");
    expect(h2h.panel.keyFigures[1]).toEqual({ value: "4 of 8", label: "Metros won · Kestrel Tonic", comparator: "top half in 4 of 8" });
    const tenants = cardOf(jobState("tenant_mix"));
    if (tenants.panel?.kind !== "figure") throw new Error("no figure");
    expect(tenants.panel.keyFigures.map((k) => k.label)).toEqual(["Tenant fit · Lantern Hi-Fi Bar", "Top climber · Lantern Hi-Fi…"]);
  });

  it("set the column's width when they stand alone", () => {
    const state = jobState("market_selection");
    const stripped: RunState = { ...state, datasets: Object.fromEntries(Object.entries(state.datasets).map(([id, d]) => [id, { ...d, data: null }])) };
    const card = cardOf(stripped);
    expect(card.panel?.kind).toBe("key_figures");
    if (card.panel?.kind === "key_figures") expect(card.panel.keyFigures[0]?.comparator).toBe("top half in 3 of 5 · vs peers");
  });
});

describe("long questions", () => {
  const words = "Which brand fits each stadium market and which of those fits sits under the radar for a summer tour".split(" ");
  const question = (n: number) => Array.from({ length: n }, (_, i) => words[i % words.length]).join(" ").replace(/$/, "?");

  it("set smaller as they grow, never more lines than their tier allows", () => {
    const tiers = [5, 12, 20, 28, 34].map((n) => questionText(question(n)));
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]!.size).toBeLessThanOrEqual(tiers[i - 1]!.size);
    expect(tiers[0]).toMatchObject({ size: 52, lines: 4 });
    expect(tiers.at(-1)).toMatchObject({ size: 30, lines: 7 });
  });

  it("truncate cleanly: whole words, no dangling punctuation, an ellipsis, within the card's limit", () => {
    const long = question(80);
    const q = questionText(long);
    expect(q.text.length).toBeLessThanOrEqual(QUESTION_MAX);
    expect(q.text.endsWith("…")).toBe(true);
    const kept = q.text.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(" ");
    expect(kept).not.toMatch(/[\s,;:.!?-]$/);

    const state = jobState("tenant_mix");
    const card = cardOf({ ...state, question: long, report: { ...state.report!, question: long } });
    expect(card.question).toEqual(q);
    expect(imageText(card)).toContain(q.text);
  });

  it("keep a question that fits whole, and print one with nothing drawable as the card's name", () => {
    expect(questionText("Which sponsors fit Marlowe Vance?").text).toBe("Which sponsors fit Marlowe Vance?");
    expect(questionText(String.fromCodePoint(0x1f964, 0x1f964)).text).toBe("A Culture Terminal brief");
  });
});

describe("ids on the card (D29)", () => {
  const states: [string, RunState][] = [
    ...Job.options.map((job): [string, RunState] => [job, jobState(job)]),
    ["brand-health", stateOf(sampleEvents("brand-health"))],
    ["brand-health-incomplete", stateOf(sampleEvents("brand-health-incomplete"))],
    ["refused", refusedState()],
  ];

  it.each(states)("%s: no run, request, Qloo call or entity id is printed or in the alt text", (_, state) => {
    const card = cardOf(state);
    const printed = [imageText(card), card.alt].join("\n");
    const ids = idsIn(state);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(printed).not.toContain(id);
    expect(printed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(printed).not.toMatch(/\burn:|\bmock-|\bqc_/i);
    for (const s of cardStrings(card)) expect(s).not.toMatch(/\burn:/i);
  });

  it("drops a label that is an id, and keeps the rest of the figure", () => {
    const state = jobState("site_selection");
    const id = Object.keys(state.datasets).find((k) => state.datasets[k as keyof typeof state.datasets]?.data?.kind === "GeoLift")!;
    const ds = state.datasets[id as keyof typeof state.datasets]!;
    const envelope = ds.data as Extract<DatasetEnvelope, { kind: "GeoLift" }>;
    const neighbourhoods = envelope.payload.neighbourhoods.map((n, i) => (i === 0 ? { ...n, name: FAKE_UUID } : i === 1 ? { ...n, name: "urn:invented:area" } : n));
    const viz = miniViz({ ...envelope, payload: { ...envelope.payload, neighbourhoods } });
    expect(viz?.kind).toBe("rows");
    if (viz?.kind !== "rows") return;
    const labels = viz.rows.map((r) => r.label);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l).not.toContain(FAKE_UUID);
      expect(l).not.toMatch(/urn:/);
      expect(l).not.toBe("");
    }
  });
});

describe("the mini viz", () => {
  it("draws a head-to-head split around the even line: the first brand's lead right in its colour, the second's left", () => {
    const viz = cardOf(jobState("head_to_head"));
    if (viz.panel?.kind !== "figure" || viz.panel.viz.kind !== "rows") throw new Error("no rows");
    const { rows, centre, legend } = viz.panel.viz;
    expect(centre).toBe(0.5);
    expect(legend.map((l) => l.tone)).toEqual(["data", "data2"]);
    for (const r of rows) {
      expect(r.bar).not.toBeNull();
      expect(r.bar!.from).toBeCloseTo(0.5);
      expect(r.bar!.tone).toBe(r.bar!.to >= 0.5 ? "data" : "data2");
    }
    expect(rows.some((r) => r.bar!.tone === "data") && rows.some((r) => r.bar!.tone === "data2")).toBe(true);
  });

  it("draws an age dumbbell with both series, ≤24 kept as written", () => {
    const card = cardOf(jobState("audience_discovery"));
    if (card.panel?.kind !== "figure" || card.panel.viz.kind !== "rows") throw new Error("no rows");
    expect(card.panel.viz.rows.map((r) => r.label)).toContain("≤24");
    for (const r of card.panel.viz.rows) expect(r.dots.map((d) => d.tone)).toEqual(["data2", "data"]);
  });

  it("draws a block's deltas: over-indexed tags right in the data colour, under-indexed left in the negative colour", () => {
    const card = cardOf(jobState("area_profile"));
    if (card.panel?.kind !== "figure" || card.panel.viz.kind !== "rows") throw new Error("no rows");
    for (const r of card.panel.viz.rows) expect(r.bar!.tone).toBe(r.bar!.to >= 0.5 ? "data" : "negative");
  });

  it("draws a taste position as ranks on a track, best at right, and says 'not measured' rather than 0", () => {
    const card = cardOf(jobState("brand_health"));
    if (card.panel?.kind !== "figure" || card.panel.viz.kind !== "rows") throw new Error("no rows");
    const byLabel = Object.fromEntries(card.panel.viz.rows.map((r) => [r.label, r]));
    expect(byLabel["Distinctiveness"]?.value).toBe("1 of 6");
    expect(byLabel["Distinctiveness"]?.dots[0]?.at).toBeGreaterThan(0.9);
    expect(byLabel["Metro breadth"]).toMatchObject({ value: "not measured", dots: [] });
  });

  it("has nothing to draw for an empty dataset", () => {
    expect(miniViz(null)).toBeNull();
  });
});

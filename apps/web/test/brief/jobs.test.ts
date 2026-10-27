// Every job's brief, from the synthetic runs of the /dev/brief viewer (app/dev/brief/job-runs.ts, invented
// entities and numbers, D29): the key-figure strip with short labels and comparator lines, the Part 5
// exhibit kinds with their source lines, the location and its CODE FALLBACK, and the next moves.
import { describe, expect, it, vi } from "vitest";
import { Job, reduceRunEvents, RunEvent, type RunState } from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { buildBriefModel, buildLocation, DESK_LABEL, SHORT_NOTE_MAX, SHORT_TRACE_MAX, type BriefModel } from "../../lib/brief";
import { readingOrder } from "./support";

// ./support replays the brand-health sample, which reads server/samples.
vi.mock("server-only", () => ({}));

function brief(job: Job): { state: RunState; model: BriefModel } {
  const events = jobRunEvents(job);
  const state = reduceRunEvents(events[0]?.runId ?? job, events);
  return { state, model: buildBriefModel(state, Date.parse(events.at(-1)?.ts ?? "")) };
}

const strip = (job: Job) => brief(job).model.evidence.keyFigures.map((k) => [k.value, k.label, k.comparator]);

describe("the synthetic job runs", () => {
  it.each(Job.options)("%s is a whole, valid run with a report", (job) => {
    const events = jobRunEvents(job);
    expect(RunEvent.array().safeParse(events).success).toBe(true);
    expect(events[0]?.type).toBe("run.created");
    expect(events.at(-1)).toMatchObject({ type: "run.end", status: "completed" });
    const { state, model } = brief(job);
    expect(state.report?.job).toBe(job);
    expect(model.mode).toBe("final");
    // Every {{M#}} and [E#] token resolved: no "not available" piece anywhere.
    expect(JSON.stringify(model)).not.toContain('"kind":"missing"');
  });
});

describe("key figures for every job", () => {
  it.each(Job.options)("%s: prints the report's strip, each number as the run displayed it", (job) => {
    const { state, model } = brief(job);
    const figures = model.evidence.keyFigures;
    expect(figures.map((k) => k.key)).toEqual(state.report?.kpis.map((k) => k.metricId));
    expect(figures.length).toBeGreaterThan(0);
    for (const k of figures) {
      expect(k.state).toBe("ready");
      const metric = state.metrics[k.key as keyof RunState["metrics"]];
      // Never a number the run did not print: the value is a piece of the metric's own display.
      expect(metric?.display, k.key).toContain(k.value ?? "missing");
      expect(k.label.length, k.label).toBeLessThanOrEqual(44);
      expect(k.label).not.toBe(metric?.label);
      if (k.comparator) expect(k.comparator.length, k.comparator).toBeLessThanOrEqual(44);
    }
  });

  it("names the neighbourhoods of a lift map and the map's precision", () => {
    expect(strip("site_selection")).toEqual([
      ["1.48×", "East Cesar Chavez", "vs restaurant baseline"],
      ["1.36×", "Holly", "vs restaurant baseline"],
      ["1.29×", "Central East Austin", "vs restaurant baseline"],
      ["0.80", "Map precision", "geohash 6 grid"],
      ["0.62", "White space · Holly", "Latent & open"],
    ]);
  });

  it("names tenants, tags and NEW counts on a block, against its city", () => {
    expect(strip("tenant_mix")).toEqual([
      ["88 of 100", "Tenant fit · Lantern Hi-Fi Bar", "site 1 of 5 · city 4 of 5"],
      ["+0.75", "Top climber · Lantern Hi-Fi Bar", "site 1 of 5 · city 4 of 5"],
      ["2 of 20", "New place tags", "area top 20 · vs Nashville"],
      ["+38", "Listening room", "NEW · rank vs Nashville"],
    ]);
    expect(strip("area_profile")[0]).toEqual(["2 of 20", "New place tags", "area top 20 · vs Austin"]);
  });

  it("names the category and the brand of each best fit, and the market of the strongest alignment", () => {
    expect(strip("sponsorship")).toEqual([
      ["0.94", "Best fit · beer", "Harrow Pale Lager"],
      ["0.91", "Best fit · spirits", "Cinder Hollow Rye"],
      ["0.88", "Best fit · trucks", "Mesa Line Trucks"],
      ["1 of 6", "Under-the-radar fits", "of the best fits"],
      ["+0.14", "Top market · Nashville", "Harrow Pale Lager · vs national"],
    ]);
  });

  it("names each side of a head-to-head and the market of a share percentile", () => {
    expect(strip("head_to_head").map(([, label]) => label)).toEqual([
      "Audience overlap",
      "Metros won · Kestrel Tonic",
      "Metros won · Brightwater Soda",
      "Youth tilt · Kestrel Tonic",
      "Youth tilt · Brightwater Soda",
    ]);
    // "wins 4 of 8 · top half in 4 of 8": the count leads, the rest goes underneath.
    expect(strip("head_to_head")[1]).toEqual(["4 of 8", "Metros won · Kestrel Tonic", "top half in 4 of 8 · vs peers"]);
    expect(strip("market_selection").slice(0, 2)).toEqual([
      ["3 of 5", "Metros won", "top half in 3 of 5 · vs peers"],
      ["0.92", "Market fit · Austin", "rank 1 of 3 · within call"],
    ]);
  });

  it("reads audience indices around the average (D38)", () => {
    expect(strip("audience_discovery").slice(0, 2)).toEqual([
      ["+0.38", "Youth index", "rank 1 of 7 · 0 = average"],
      ["7 of 31", "Distinctive tags", "facet tags · vs 6 peers"],
    ]);
    expect(strip("brand_health")).toEqual([
      ["0.56", "Nearest audience", "with Granite Outfitters"],
      ["1 of 6", "Distinctiveness", "vs peers"],
      // A youth index keeps its own name in the next-gen slot, never the share tilt's.
      ["+0.31", "Youth index", "0 = average"],
      ["Flat", "Momentum", "Apr–Sep 2025 only"],
    ]);
  });
});

describe("the Part 5 exhibits", () => {
  it("lays out a lift map, slopes, momentum, a position card and a slate with their source lines", () => {
    const kinds = Job.options.flatMap((job) => brief(job).model.evidence.figures.map((f) => f.kind));
    for (const kind of ["GeoLift", "Slope", "Momentum", "Position", "Slate", "Bars", "Matrix", "Quadrant", "Ranked"] as const) expect(kinds).toContain(kind);
    for (const job of Job.options) {
      for (const f of brief(job).model.evidence.figures) {
        expect(f.viz.length).toBeGreaterThan(0);
        expect(f.source.text).toMatch(/^Source: Qloo \/v2\/(insights|trending)/);
        expect(f.dataset?.kind).toBe(f.kind);
        expect(f.methodHref).toMatch(/^\/method#/);
      }
    }
  });

  it("names the place a location figure reads and how", () => {
    const [map, block] = brief("site_selection").model.evidence.figures;
    expect(map?.source.text).toBe("Source: Qloo /v2/insights · location ← Austin · 3 requests · computed in code");
    expect(map?.location).toEqual({ place: "Austin", method: null, text: null, fallbackNotes: [] });
    expect(block?.source.text).toBe("Source: Qloo /v2/insights · location ← East Cesar Chavez · 2 requests · read by POINT · computed in code");
    expect(block?.location).toMatchObject({ place: "East Cesar Chavez", method: "POINT", text: "read by POINT" });
    // A figure that reads no place says nothing about one.
    expect(brief("sponsorship").model.evidence.figures.every((f) => f.location === null && f.source.place === null)).toBe(true);
  });
});

describe("the location of a location brief", () => {
  it("names the area, the city, the method and the CODE FALLBACK that got there", () => {
    const { model } = brief("tenant_mix");
    expect(model.location?.place).toBe("ZIP 37206 (East Nashville), Nashville");
    expect(model.location?.city).toBe("Nashville");
    expect(model.location?.areas).toEqual([
      {
        name: "ZIP 37206 (East Nashville)",
        method: "POINT",
        methodLabel: "a centre point",
        fallbacks: [{ from: "POLYGON", to: "POINT", reason: "POLYGON returned no taste tags", line: "CODE FALLBACK · POLYGON → POINT: POLYGON returned no taste tags", footnote: expect.any(Number) }],
      },
    ]);
    expect(brief("area_profile").model.location).toMatchObject({ place: "Holly, Austin", areas: [{ name: "Holly", method: "POLYGON", fallbacks: [] }] });
    for (const job of ["brand_health", "head_to_head", "sponsorship", "market_selection", "audience_discovery"] as const) expect(brief(job).model.location).toBeNull();
  });

  it("reads an area read twice as one area: its last method and every read's fallbacks", () => {
    const { state } = brief("tenant_mix");
    const first = state.toolCalls.find((t) => t.tool === "block_dna");
    const step = state.fallbacks.find((f) => f.toolCallId === first?.toolCallId);
    if (!first || !step) throw new Error("no Block DNA call with a fallback in the tenant-mix run");
    const evidence = Object.values(state.evidence).find((e) => first.evidenceIds.includes(e.id));
    if (!evidence) throw new Error("no evidence behind the Block DNA call");
    // A second read of the same area, one more step down the ladder: its fingerprint, no figure of its own yet.
    const fingerprint = { ...evidence, id: "E90" as typeof evidence.id, purpose: "Tag fingerprint of ZIP 37206 (East Nashville) by QUERY" };
    const again = { ...first, toolCallId: "block-again", datasetIds: [], evidenceIds: [fingerprint.id], qlooCallIds: [] };
    const twice: RunState = {
      ...state,
      evidence: { ...state.evidence, [fingerprint.id]: fingerprint },
      toolCalls: [...state.toolCalls, again],
      fallbacks: [...state.fallbacks, { ...step, toolCallId: again.toolCallId, from: "POINT", to: "QUERY", reason: "POINT returned no taste tags" }],
    };
    const location = buildLocation(twice);
    expect(location?.areas.map((a) => [a.name, a.method, a.fallbacks.map((f) => `${f.from} → ${f.to}`)])).toEqual([
      ["ZIP 37206 (East Nashville)", "QUERY", ["POLYGON → POINT", "POINT → QUERY"]],
    ]);
    expect(location?.place).toBe("ZIP 37206 (East Nashville), Nashville");
  });

  it("cites each fallback once, right after its figure's own note, with a short note and trace for the margin", () => {
    const { model } = brief("site_selection");
    const block = model.evidence.figures[1];
    const n = block?.location?.fallbackNotes[0];
    expect(n).toBe((block?.footnote ?? 0) + 1);
    expect(model.location?.areas[0]?.fallbacks[0]?.footnote).toBe(n);
    const note = model.footnotes.find((f) => f.n === n);
    expect(note).toMatchObject({ kind: "fallback", fallback: { from: "POLYGON", to: "POINT" } });
    expect(note?.short.trace).toBe("code fallback · POLYGON → POINT");
    expect(note?.short.text).toBe("POLYGON returned no taste tags, so code read East Cesar Chavez by POINT.");
    expect(note?.text).toContain("Costs 10 conviction points.");
    // The receipts of the empty rung stand behind it.
    expect(note?.requests.length).toBe(1);
    // The notes still read 1, 2, 3 down the page.
    expect(readingOrder(model)).toEqual(model.footnotes.map((f) => f.n));
  });

  it.each(Job.options)("%s: numbers its notes in reading order, each short enough for the margin", (job) => {
    const { model } = brief(job);
    expect(readingOrder(model)).toEqual(model.footnotes.map((f) => f.n));
    for (const f of model.footnotes) {
      if (f.kind !== "figure") expect(f.short.text.length, f.short.text).toBeLessThanOrEqual(SHORT_NOTE_MAX);
      expect(f.short.trace.length, f.short.trace).toBeLessThanOrEqual(SHORT_TRACE_MAX);
      // A place is named, never printed as its gazetteer id.
      expect(f.short.text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});

describe("next moves", () => {
  it.each(Job.options)("%s: chips with a desk, opening Ask with this brief as the parent", (job) => {
    const { state, model } = brief(job);
    expect(model.nextMoves.map((m) => m.question)).toEqual(state.report?.nextMoves.map((m) => m.question));
    for (const m of model.nextMoves) {
      expect(m.deskLabel).toBe(DESK_LABEL[m.pillar]);
      expect(m.href).toBe(`/ask?${new URLSearchParams({ q: m.question, parent: state.runId }).toString()}`);
    }
  });

  it("carries a brief to the other desks", () => {
    // The sponsorship run's labels open with their desk, which the chip prints on its own.
    expect(brief("sponsorship").state.report?.nextMoves[0]?.label).toBe("MARKETING · Tour cities");
    expect(brief("sponsorship").model.nextMoves.map((m) => [m.label, m.pillar])).toEqual([
      ["Tour cities", "marketing"],
      ["After-party block", "location"],
      ["Who the fans are", "audience"],
    ]);
    expect(brief("site_selection").model.nextMoves.map((m) => m.pillar)).toEqual(["location", "audience", "marketing"]);
  });
});

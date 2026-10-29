// buildAnswerModel (lib/answer): the answer page's view-model from the synthetic run of each job
// (app/dev/brief/job-runs, invented entities, D29). Key numbers worded per job, the figure each slot takes,
// the layout rows, the AI-alone title rule, what could change this and the head.
import { describe, expect, it } from "vitest";
import { GHOST_HONESTY_LINE, Job, reduceRunEvents, type GeoLiftPayload, type GhostAnswer, type GhostDiff, type Metric, type RunEvent } from "@ct/contracts";
import { ghostRunEvents } from "../../app/dev/brief/ghost-runs";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { variantEvents } from "../../app/dev/brief/variants";
import {
  answerLayout,
  areaName,
  buildAnswerModel,
  buildGhost,
  formatValue,
  headlineWithPeriod,
  layoutRows,
  marketState,
  type AnswerModel,
  type AnswerRun,
} from "../../lib/answer";
import { buildBriefModel } from "../../lib/brief";

function answerOf(events: readonly RunEvent[]): AnswerModel {
  const state = reduceRunEvents(events[0]?.runId ?? "run", events);
  const model = buildBriefModel(state, Date.parse(events.at(-1)?.ts ?? ""));
  return buildAnswerModel(model, state);
}

const answer = (job: Job, ghost = false) => answerOf(ghost ? (ghostRunEvents(job) ?? []) : jobRunEvents(job));
const words = (a: AnswerModel) => a.keyNumbers.map((k) => (k.variant === "split" ? `${k.label}: ${k.sides.map((s) => s.value).join(":")}` : `${k.value} | ${k.label} | ${k.context ?? ""}`));

describe("every job", () => {
  it.each(Job.options)("%s: a verdict with its period, a checked line, at most three key numbers with a footnote each", (job) => {
    const a = answer(job);
    expect(a.job).toBe(job);
    expect(a.verdict.kind).toBe("answer");
    expect(a.verdict.line).toMatch(/\.$/);
    expect(a.verdict.check?.ok).toBe(true);
    // Public figures name their source too: "against Qloo and Census data".
    expect(a.verdict.check?.text).toMatch(/^All \d+ numbers checked against Qloo(, SEC)?( and (SEC|Census))? data$/);
    expect(a.keyNumbers.length).toBeGreaterThan(0);
    expect(a.keyNumbers.length).toBeLessThanOrEqual(3);
    for (const k of a.keyNumbers) expect(k.footnote).not.toBeNull();
    expect(a.head.eyebrow).toContain("Data as of 21 Oct 2026");
    expect(a.head.mobileEyebrow).toMatch(/ · 21 Oct 2026$/);
    expect(a.ask.placeholder).toMatch(/^Ask a follow-up about /);
    expect(a.changes.length).toBeLessThanOrEqual(3);
    // Never a gazetteer id or a raw rank code in the words the page prints.
    expect(JSON.stringify(words(a))).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });

  it.each(Job.options)("%s: every row cell has something to draw, and spans add up to six", (job) => {
    const a = answer(job);
    for (const row of a.rows) {
      expect(row.reduce((n, c) => n + c.span, 0)).toBe(6);
      for (const cell of row) {
        if (cell.slot === "guesses") continue;
        if (cell.slot === "map") expect(a.charts.map !== null || a.area !== null).toBe(true);
        else expect(a.charts[cell.slot]).not.toBeNull();
      }
    }
  });

  it.each(Job.options)("%s: lists only figures it does not draw under More charts, at most four", (job) => {
    const a = answer(job);
    const drawn = [a.charts.main, a.charts.second, a.charts.third, a.charts.map].filter((c) => c !== null).map((c) => c.datasetId);
    expect(a.more.length).toBeLessThanOrEqual(4);
    for (const m of a.more) expect(drawn).not.toContain(m.datasetId);
  });
});

/**
 * The synthetic site_selection run with its lift map changed: the areas the question names, a
 * supply that could not be counted, and metrics added (the run's lift.rank for a named area).
 */
function siteWith(change: {
  focus?: string[];
  supplyGap?: string;
  metrics?: Metric[];
  /** Any other change to the lift map's payload. */
  payload?: (p: GeoLiftPayload) => GeoLiftPayload;
  /** The area the question names (CLERK's geo.area). */
  area?: string;
  /** The lift map is not streamed inline: fetched after the first paint. */
  fetched?: boolean;
}): AnswerModel {
  const events = jobRunEvents("site_selection");
  const out: RunEvent[] = [];
  for (const e of events) {
    if (e.type === "clerk" && change.area !== undefined) {
      out.push({ ...e, intent: { ...e.intent, geo: { ...e.intent.geo, area: change.area } } });
    } else if (e.type === "dataset.ready" && e.inline?.kind === "GeoLift" && change.fetched) {
      out.push({ ...e, inline: null });
    } else if (e.type === "dataset.ready" && e.inline?.kind === "GeoLift") {
      const p = change.payload ? change.payload(e.inline.payload) : e.inline.payload;
      const neighbourhoods = change.supplyGap ? p.neighbourhoods.map((n) => ({ ...n, supplyCount: null, supplyPct: null, whiteSpace: null, quadrant: null })) : p.neighbourhoods;
      const payload = { ...p, neighbourhoods, ...(change.focus ? { focusAreas: change.focus } : {}), ...(change.supplyGap ? { supplyGap: change.supplyGap, supply: null } : {}) };
      out.push({ ...e, inline: { ...e.inline, payload } });
      for (const metric of change.metrics ?? []) out.push({ ...e, seq: e.seq, type: "metric", metric } as unknown as RunEvent);
    } else out.push(e);
  }
  return answerOf(out.map((e, i) => ({ ...e, seq: i + 1 })));
}

const rankMetric = (area: string, display: string, value: number): Metric => ({
  id: "M90" as Metric["id"],
  key: "lift.rank",
  label: "rank by lift among the areas with one (1 = highest)",
  subjectRefs: [area, "T1"],
  value,
  reason: null,
  display,
  unit: "rank",
  badge: "DERIVED",
  formulaId: "lift.area",
  evidenceIds: ["E1" as Metric["evidenceIds"][number]],
  n: 7,
  conf: null,
  comparator: null,
  window: null,
});

describe("site_selection: the area the question names, and competition", () => {
  it("shows the named area first with its rank among all areas, then the top area and competition", () => {
    const a = siteWith({ focus: ["downtown"], metrics: [rankMetric("downtown", "7 of 7", 7)] });
    expect(words(a)).toEqual([
      "Downtown | Your area | #7 of 7 areas for this concept · 0.82× the interest of a typical area",
      "East Cesar Chavez | Top area | 1.48× the interest of a typical area",
      expect.stringMatching(/^.+ \| Competition \| \d+ similar venues? in Downtown in Qloo's venue sample \(capped, so more may exist\)$/),
    ]);
  });

  it("says plainly when the named area has too few cells for a reliable reading", () => {
    const a = siteWith({ focus: ["hyde_park"] });
    expect(words(a)[0]).toBe("Hyde Park | Your area | Not enough data: too few map cells for a reliable reading");
  });

  it("does not repeat the top area when the question names it", () => {
    const a = siteWith({ focus: ["east_cesar_chavez"], metrics: [rankMetric("east_cesar_chavez", "1 of 7", 1)] });
    expect(words(a)[0]).toBe("East Cesar Chavez | Your area | #1 of 7 areas for this concept · 1.48× the interest of a typical area");
    expect(words(a).some((w) => w.includes("| Top area |"))).toBe(false);
  });

  it("gives every area the question names its own number, the second as Also named, then competition", () => {
    const a = siteWith({ focus: ["downtown", "holly"], metrics: [rankMetric("downtown", "7 of 7", 7)] });
    const w = words(a);
    expect(w[0]).toBe("Downtown | Your area | #7 of 7 areas for this concept · 0.82× the interest of a typical area");
    expect(w[1]).toMatch(/^Holly \| Also named \| #\d+ of 7 areas for this concept · /);
    expect(w[2]).toMatch(/\| Competition \|/);
    if (a.charts.map?.body.type !== "map") throw new Error("map expected");
    expect(a.charts.map.body.data?.focusAreas).toEqual(["downtown", "holly"]);
  });

  it("says plainly when the area the question names is not on the map, never answering another area for it", () => {
    const w = words(siteWith({ area: "Quarry Glen Village" }));
    expect(w[0]).toBe("Quarry Glen Village | Your area | No reading of its own: it matches none of the Austin area names this map lists");
  });

  it("finds the asked area by its name on a map stored without focus areas", () => {
    const w = words(siteWith({ area: "Downtown" }));
    expect(w[0]).toMatch(/^Downtown \| Your area \| #\d+ of 7 areas for this concept · 0\.82× /);
  });

  it("reads a stored sample too thin to compare areas as unknown, never as 0 or few", () => {
    const thin = (p: GeoLiftPayload): GeoLiftPayload => ({
      ...p,
      neighbourhoods: p.neighbourhoods.map((n, i) => ({ ...n, supplyCount: n.supplyCount === null ? null : i === 0 ? 2 : 0 })),
    });
    const a = siteWith({ payload: thin });
    const rivals = a.keyNumbers.find((k) => k.label === "Competition");
    expect(rivals).toMatchObject({ value: "Unknown" });
    expect(rivals?.variant !== "split" && rivals?.context).toMatch(/places only 2 similar venues in the Austin areas this map compares, too few/);
    if (a.charts.map?.body.type !== "map") throw new Error("map expected");
    expect(a.charts.map.body.areas.every((r) => !r.fewRivals)).toBe(true);
  });

  it("never reads an area with no venue in a capped sample as few rivals", () => {
    const none = (p: GeoLiftPayload): GeoLiftPayload => ({
      ...p,
      neighbourhoods: p.neighbourhoods.map((n) => (n.id === "east_cesar_chavez" ? { ...n, supplyCount: 0 } : n)),
    });
    const a = siteWith({ payload: none });
    const rivals = a.keyNumbers.find((k) => k.label === "Competition");
    expect(rivals).toMatchObject({ value: "Not enough venue data" });
    expect(rivals?.variant !== "split" && rivals?.context).toMatch(
      /^None of the 5 similar venues in Qloo's capped venue sample for Austin is in East Cesar Chavez; a capped sample cannot show how many exist there, so competition there is unknown\.$/,
    );
    if (a.charts.map?.body.type !== "map") throw new Error("map expected");
    expect(a.charts.map.body.areas.find((r) => r.name === "East Cesar Chavez")?.fewRivals).toBe(false);
  });

  it("reads a ranked area with no quadrant as Not enough venue data, and keeps a count with nothing to rank it against a count", () => {
    const flat = (unranked: boolean) => (p: GeoLiftPayload): GeoLiftPayload => ({
      ...p,
      supply: p.supply === null ? null : { ...p.supply, capped: false },
      neighbourhoods: p.neighbourhoods.map((n) => ({ ...n, quadrant: null, ...(unranked && n.id === "east_cesar_chavez" ? { demandPct: null } : {}) })),
    });
    const withheld = siteWith({ payload: flat(false) }).keyNumbers.find((k) => k.label === "Competition");
    expect(withheld).toMatchObject({ variant: "word", value: "Not enough venue data" });
    expect(withheld?.variant !== "split" && withheld?.context).toMatch(/^Only 2 similar venues in East Cesar Chavez in Qloo's venue sample: too few to call the area crowded or open/);
    const rivals = siteWith({ payload: flat(true) }).keyNumbers.find((k) => k.label === "Competition");
    expect(rivals).toMatchObject({ variant: "number", value: "2", context: "2 similar venues in East Cesar Chavez in Qloo's venue sample, not every business" });
  });

  it("never calls an area busy with rivals from fewer than three venues in a stored run", () => {
    const crowded = (p: GeoLiftPayload): GeoLiftPayload => ({
      ...p,
      neighbourhoods: p.neighbourhoods.map((n) => (n.id === "east_cesar_chavez" ? { ...n, supplyCount: 1, quadrant: "PROVEN_CROWDED" as const } : n)),
    });
    const rivals = siteWith({ payload: crowded }).keyNumbers.find((k) => k.label === "Competition");
    expect(rivals).toMatchObject({ value: "Not enough venue data" });
    expect(JSON.stringify(rivals)).not.toMatch(/Busy with rivals/);
  });

  it("credits the boundary source on the answer's map", () => {
    const a = siteWith({});
    if (a.charts.map?.body.type !== "map") throw new Error("map expected");
    expect(a.charts.map.body.caption).toMatch(/ Boundaries: City of Austin neighbourhood planning areas \(public domain\)\.$/);
  });

  it("keeps the map's row while its data loads, so the page does not move when it lands", () => {
    const loading = siteWith({ fetched: true });
    expect(loading.charts.map).toBeNull();
    expect(loading.mapPending).toBe(true);
    expect(loading.rows[0]?.map((c) => c.slot)).toEqual(["map"]);
  });

  it("reads competition as unknown with the reason, never as 0 or few, when similar venues could not be counted", () => {
    const gap = "We can't count similar venues in Austin: Qloo's venue data has no verified category for Pottery Studio, so the number of competitors here is unknown, not zero.";
    const a = siteWith({ supplyGap: gap });
    const rivals = a.keyNumbers.find((k) => k.label === "Competition");
    expect(rivals).toMatchObject({ value: "Unknown", context: gap });
    expect(JSON.stringify(a.keyNumbers)).not.toMatch(/Few rivals|Busy with rivals|\b0 similar/);
    if (a.charts.map?.body.type !== "map") throw new Error("map expected");
    expect(a.charts.map.body.caption).toContain("Similar venues could not be counted area by area, so competition is unknown.");
    expect(a.charts.map.body.areas.every((r) => !r.fewRivals)).toBe(true);
  });
});

describe("per job", () => {
  it("brand_health: closest audience, distinctiveness and age lean; the closest audiences as bars, #1 in accent", () => {
    const a = answer("brand_health", true);
    expect(words(a)).toEqual([
      "0.56 match | Closest audience | Granite Outfitters · 1.00 = identical",
      "#1 of 6 | Most distinctive fans | among the brands compared",
      "Leans younger | Age lean | +0.31 vs the average audience",
    ]);
    expect(a.head.eyebrow).toBe("Brands & investing · Real competitors · Data as of 21 Oct 2026");
    expect(a.verdict.advice).toBe("Taste signals, not buy or sell advice.");
    const main = a.charts.main;
    expect(main?.kind).toBe("Closest audiences");
    expect(main?.caption).toBe("1.00 = identical tastes. Shared taste, not shared customers.");
    if (main?.body.type !== "bars") throw new Error("bars expected");
    expect(main.body.rows.map((r) => r.label)).toEqual(["Granite Outfitters", "Foxglove Cola", "Harbor Seltzer", "Kettle Ridge Tonic", "Saltmarsh Seltzer"]);
    expect(main.body.rows.map((r) => r.tone)).toEqual(["accent", "muted", "muted", "muted", "muted"]);
    expect(main.table?.rows[0]).toEqual(["Granite Outfitters", "0.56"]);
    expect(a.rows.map((r) => r.map((c) => `${c.slot}:${c.span}`))).toEqual([["main:4", "guesses:2"]]);
    expect(a.more.map((m) => m.name)).toEqual(["Where it stands vs its peers", "Interest over Apr–Sep 2025"]);
    expect(a.ghostSpan).toBe(3);
  });

  it("head_to_head: the compare head, and the city and age counts the chart draws", () => {
    const a = answer("head_to_head");
    expect(a.head.compare).toEqual({ subject: "Kestrel Tonic", second: "Brightwater Soda" });
    expect(words(a)).toEqual(["0.62 match | Taste overlap | each other's closest rival", "Cities where it ranks first: 3:4", "Age groups where it ranks first: 4:2"]);
    const main = a.charts.main;
    if (main?.body.type !== "winner") throw new Error("winner expected");
    expect(main.body.score).toEqual({ a: 3, b: 4, label: "cities where each ranks first" });
    expect(main.body.tables.map((t) => t.title)).toEqual(["Cities", "Age groups"]);
    // Denver sits inside the even band: no winner.
    expect(main.body.tables[0]?.rows.find((r) => r.label === "Denver")?.winner).toBeNull();
    // Both figures are drawn in "Who wins where": nothing left for More charts.
    expect(a.more).toEqual([]);
    expect(a.ask.placeholder).toBe("Ask a follow-up about Kestrel Tonic and Brightwater Soda");
  });

  it("site_selection: top area, runners-up and competition; the map, then more and less of with the guesses", () => {
    const a = answer("site_selection");
    expect(a.head.eyebrow).toBe("Places · Where to open · Austin, TX · Data as of 21 Oct 2026");
    expect(a.verdict.advice).toBeNull();
    expect(words(a)).toEqual([
      "East Cesar Chavez | Top area | 1.48× the interest of a typical area",
      "Holly · Central East Austin | Runners-up | 1.36× and 1.29×",
      "Few rivals nearby | Competition | 2 similar venues in East Cesar Chavez in Qloo's venue sample (capped, so more may exist)",
    ]);
    expect(a.charts.map?.body.type).toBe("map");
    if (a.charts.map?.body.type === "map") expect(a.charts.map.body.areas.map((r) => r.name)).toEqual(["East Cesar Chavez", "Holly", "Central East Austin"]);
    const second = a.charts.second;
    if (second?.body.type !== "more-less") throw new Error("more-less expected");
    expect(second.body.more[0]).toMatchObject({ label: "Listening room", display: "+42", tag: "new-here" });
    expect(second.body.less[0]?.display).toBe("−21");
    expect(a.rows.map((r) => r.map((c) => c.slot))).toEqual([["map"], ["second", "guesses"]]);
    expect(a.ask.placeholder).toBe("Ask a follow-up about Austin");
  });

  it("tenant_mix: the best fit out of 100, the area map with the corner, fit rows and the pair chart", () => {
    const a = answer("tenant_mix");
    expect(a.head.eyebrow).toBe("Places · Best tenant for a space · East Nashville · Data as of 21 Oct 2026");
    expect(words(a)[0]).toBe("88/100 | Best fit for this corner | Lantern Hi-Fi Bar · #1 of 5");
    expect(a.area).toEqual({ metro: "nashville", name: "ZIP 37206 (East Nashville)", label: "East Nashville", corner: true });
    const main = a.charts.main;
    if (main?.body.type !== "fit") throw new Error("fit expected");
    expect(main.body.rows[0]).toMatchObject({ rank: 1, label: "Lantern Hi-Fi Bar", display: "88/100", climbs: true });
    expect(a.charts.second?.body.type).toBe("pair");
    expect(a.rows.map((r) => r.map((c) => `${c.slot}:${c.span}`))).toEqual([["map:3", "main:3"], ["second:4", "guesses:2"]]);
    expect(a.ask.placeholder).toBe("Ask a follow-up about East Nashville");
  });

  it("area_profile: built from the place grammar, with the area map and no corner", () => {
    const a = answer("area_profile");
    expect(a.head.eyebrow).toBe("Places · What an area is like · Holly · Data as of 21 Oct 2026");
    expect(a.area?.corner).toBe(false);
    expect(words(a).slice(0, 2)).toEqual(["2 | New tastes in the area | new here vs Austin overall", "Listening room | Most over-represented | +38 ranks vs Austin"]);
    // No Slope figure in this run: the map takes the row alone.
    expect(a.charts.main).toBeNull();
    expect(a.rows.map((r) => r.map((c) => `${c.slot}:${c.span}`))).toEqual([["map:6"], ["second:4", "guesses:2"]]);
  });

  it("sponsorship: two best fits by name, hidden gems, the slate across the row", () => {
    const a = answer("sponsorship", true);
    const [first, second, third] = a.keyNumbers;
    expect(first).toMatchObject({ variant: "name", value: "Harrow Pale Lager", label: "Best fit · beer", tag: "hidden-gem" });
    expect(second).toMatchObject({ variant: "name", value: "Cinder Hollow Rye", tag: null });
    expect(third).toMatchObject({ value: "1 of 6", label: "Hidden gems" });
    const main = a.charts.main;
    if (main?.body.type !== "slate") throw new Error("slate expected");
    expect(main.body.rows.map((r) => r.icon)).toEqual(["beer", "wine", "shopping-bag", "shirt", "tent", "shopping-bag"]);
    // Each best fit links to its profile (a brand: no ?type=).
    expect(main.body.rows[0]?.href).toBe("/d/Harrow%20Pale%20Lager");
    for (const r of main.body.rows) expect(r.href).toBe(r.best === null ? null : `/d/${encodeURIComponent(r.best)}`);
    // No "What else they love" here, and an AI alone card in row E: the guesses sit beside the slate.
    expect(a.rows.map((r) => r.map((c) => `${c.slot}:${c.span}`))).toEqual([["main:4", "guesses:2"]]);
    expect(a.guessesBesideChange).toBe(false);
    expect(a.ghost?.title).toBe("AI alone named the biggest brands");
  });

  it("market_selection: markets led, the best city, and rank tracks by market", () => {
    const a = answer("market_selection");
    expect(words(a)[0]).toBe("3 of 5 | Markets where Juniper Cola leads | vs 2 other brands");
    expect(words(a)[1]).toBe("Austin | Best-fit city | #1 of 3 brands");
    const main = a.charts.main;
    if (main?.body.type !== "ranks") throw new Error("ranks expected");
    expect(main.kind).toBe("Where Juniper Cola out-draws other brands");
    expect(main.body.rows[0]).toMatchObject({ label: "Austin", sublabel: "TX", rank: 1, of: 3, display: "#1 of 3" });
    expect(main.body.rows.map((r) => r.sublabel)).toEqual(["TX", "TN", "CO", "GA", "IL"]);
    expect(main.table?.rows[0]?.[0]).toBe("Austin, TX");
  });

  it("audience_discovery: the age peak, hidden gems, the fans diverging and the neighbour columns", () => {
    const a = answer("audience_discovery");
    expect(words(a).slice(0, 2)).toEqual(["Peaks at 25–29 | Age lean | +0.31 vs the average audience", "3 | Hidden gems | strong fit, less known"]);
    const main = a.charts.main;
    if (main?.body.type !== "diverging") throw new Error("diverging expected");
    expect(main.body.rows.map((r) => r.display)).toEqual(["+0.05", "+0.31", "+0.24", "+0.12", "−0.12", "−0.27"]);
    const second = a.charts.second;
    if (second?.body.type !== "neighbours") throw new Error("neighbours expected");
    expect(second.body.columns.map((c) => c.label)).toEqual(["Music", "Podcasts", "TV"]);
    // Each name links to its profile with its domain's type.
    for (const c of second.body.columns) for (const item of c.items) expect(item.href).toMatch(/^\/d\/[^?]+\?type=(artist|podcast|tv_show)$/);
    expect(a.rows.map((r) => r.map((c) => `${c.slot}:${c.span}`))).toEqual([["main:3", "guesses:3"], ["second:6"]]);
  });

  it("not enough data: the verdict says so, with the plain chip", () => {
    const a = answerOf(variantEvents(jobRunEvents("brand_health"), "notenough"));
    expect(a.verdict).toMatchObject({ kind: "not_enough", line: "Not enough data to call this", confidence: "insufficient_evidence" });
  });
});

describe("AI alone", () => {
  const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] };
  const run = (picks: Partial<GhostAnswer["picks"]>, items: GhostDiff["items"], pop: GhostDiff["meanPopularity"]): AnswerRun => ({
    resolves: [],
    ghost: {
      answer: { headline: "Invented.", picks: { ...NO_PICKS, ...picks }, numeric_claims: [] },
      diff: { items, overlapAt5: null, resolvability: null, unsourcedNumericClaims: 0, meanPopularity: pop, honestyLine: GHOST_HONESTY_LINE },
    },
  });
  const item = (name: string, status: "both" | "qloo_only" | "llm_only") => ({ name, category: "neighbourhoods" as const, status, resolvesInQloo: null, ref: null });

  it("says the AI picked busier areas when its picks are 10 points better known", () => {
    const g = buildGhost("site_selection", run({ neighbourhoods: ["Alder Flats", "Birch Row"] }, [item("Alder Flats", "llm_only"), item("Birch Row", "both"), item("Cedar Bend", "qloo_only")], { ghost: 0.7, qloo: 0.55 }));
    expect(g?.title).toBe("AI alone picked busier areas");
    expect(g?.subline).toBe("Same AI, no data. 1 of its top 5 areas matches the data's top 5.");
    expect(g?.ai).toEqual([
      { name: "Alder Flats", both: false },
      { name: "Birch Row", both: true },
    ]);
  });

  it("counts the matches otherwise, and names different picks when none match", () => {
    const some = buildGhost("site_selection", run({ neighbourhoods: ["Birch Row"] }, [item("Birch Row", "both")], { ghost: 0.5, qloo: 0.45 }));
    expect(some?.title).toBe("AI alone matched 1 of the data's top 5 areas");
    const none = buildGhost("site_selection", run({ neighbourhoods: ["Alder Flats"] }, [item("Alder Flats", "llm_only")], { ghost: null, qloo: 0.4 }));
    expect(none?.title).toBe("AI alone named different areas");
    expect(none?.subline).toBe("Same AI, no data. 0 of its top 5 areas match the data's top 5.");
  });

  it("is null without a GHOST", () => {
    expect(buildGhost("brand_health", { resolves: [] })).toBeNull();
  });
});

describe("helpers", () => {
  it("reads an area's common name from its gazetteer name", () => {
    expect(areaName("ZIP 37206 (East Nashville)")).toBe("East Nashville");
    expect(areaName("Holly")).toBe("Holly");
  });

  it("formats values by unit, with a true minus sign", () => {
    expect(formatValue(1.476, "lift")).toBe("1.48×");
    expect(formatValue(-24, "delta")).toBe("−24");
    expect(formatValue(38, "delta")).toBe("+38");
    expect(formatValue(-0.18, "index")).toBe("−0.18");
    expect(formatValue(0.84, "similarity")).toBe("0.84");
  });

  it("ends the headline with a full stop, before trailing citations, and leaves an ended one alone", () => {
    const cite = { kind: "cite", evidenceId: "E1", footnote: 1 } as const;
    expect(headlineWithPeriod([{ kind: "text", text: "Its nearest audience is an outfitter, not a cola" }])).toEqual([
      { kind: "text", text: "Its nearest audience is an outfitter, not a cola." },
    ]);
    expect(headlineWithPeriod([{ kind: "text", text: "Fans lean young " }, cite])).toEqual([{ kind: "text", text: "Fans lean young." }, cite]);
    expect(headlineWithPeriod([{ kind: "text", text: "Is it?" }])).toEqual([{ kind: "text", text: "Is it?" }]);
    expect(headlineWithPeriod([{ kind: "text", text: 'They said "go."' }])).toEqual([{ kind: "text", text: 'They said "go."' }]);
    expect(headlineWithPeriod([{ kind: "text", text: "Fit reads " }, { kind: "window", text: "this week" }])).toEqual([
      { kind: "text", text: "Fit reads " },
      { kind: "window", text: "this week" },
      { kind: "text", text: "." },
    ]);
    expect(headlineWithPeriod(null)).toBeNull();
    expect(headlineWithPeriod([])).toEqual([]);
  });

  it("every job's headline ends with a full stop", () => {
    for (const job of Job.options) {
      const h = answer(job).verdict.headline;
      if (!h || h.length === 0) continue;
      const last = h.filter((p) => p.kind !== "cite").at(-1);
      expect(last?.kind === "text" ? last.text : ".").toMatch(/[.!?]["')\]]*$/);
    }
  });

  it("reads a market row's state from its id, or its label when the name is unique", () => {
    expect(marketState({ key: "metro:denver", label: "Denver" })).toBe("CO");
    expect(marketState({ key: "nashville", label: "Nashville" })).toBe("TN");
    expect(marketState({ key: "M7", label: "Atlanta" })).toBe("GA");
    expect(marketState({ key: "M8", label: "Atlantis" })).toBeNull();
  });

  it("finds the guesses a place when they are left alone in a row", () => {
    const sponsorship = { main: true, second: false, map: false, guesses: true };
    // No AI alone card: beside Change in row E.
    expect(answerLayout("sponsorship", sponsorship, false)).toEqual({ rows: [[{ slot: "main", span: 6 }]], guessesBesideChange: true });
    // With one: beside the chart alone in the row above.
    expect(answerLayout("sponsorship", sponsorship, true)).toEqual({
      rows: [
        [
          { slot: "main", span: 4 },
          { slot: "guesses", span: 2 },
        ],
      ],
      guessesBesideChange: false,
    });
    // brand_health with no main chart: beside the chart below.
    expect(answerLayout("brand_health", { main: false, second: true, map: false, guesses: true }, true).rows).toEqual([
      [
        { slot: "second", span: 4 },
        { slot: "guesses", span: 2 },
      ],
    ]);
    // Nothing else to stand beside and an AI alone card: the whole row.
    expect(answerLayout("brand_health", { main: false, second: false, map: false, guesses: true }, true)).toEqual({ rows: [[{ slot: "guesses", span: 6 }]], guessesBesideChange: false });
    // Guesses already beside a chart: unchanged.
    expect(answerLayout("brand_health", { main: true, second: true, map: false, guesses: true }, false).guessesBesideChange).toBe(false);
  });

  it("drops cells with nothing to draw, and a cell left alone takes the row", () => {
    expect(layoutRows("site_selection", { map: false, main: false, second: true, guesses: true })).toEqual([
      [
        { slot: "second", span: 4 },
        { slot: "guesses", span: 2 },
      ],
    ]);
    expect(layoutRows("brand_health", { map: false, main: false, second: false, guesses: true })).toEqual([[{ slot: "guesses", span: 6 }]]);
    expect(layoutRows("tenant_mix", { map: false, main: true, second: false, guesses: false })).toEqual([[{ slot: "main", span: 6 }]]);
  });
});

describe("Part 9 jobs", () => {
  const body = <T extends string>(a: AnswerModel, slot: "main" | "second" | "third", type: T) => {
    const chart = a.charts[slot];
    expect(chart?.body.type, slot).toBe(type);
    return chart as NonNullable<AnswerModel["charts"]["main"]> & { body: Extract<NonNullable<AnswerModel["charts"]["main"]>["body"], { type: T }> };
  };

  it("taste_twins: twins ranked by match with the sample said, the shared tastes, and Census residents beside them", () => {
    const a = answer("taste_twins");
    expect(a.head.eyebrow).toContain("Find an area's twin");
    const twins = body(a, "main", "bars");
    expect(twins.body.rows[0]).toMatchObject({ label: "ZIP 37206 (East Nashville)", display: "0.71", tone: "accent" });
    // An area that could not be matched keeps its row and says so; it never reads as 0.
    expect(twins.body.rows.at(-1)).toMatchObject({ label: "ZIP 37203", display: "No data", fraction: 0 });
    expect(twins.caption).toContain("1.00 = the same mix of tastes");
    expect(twins.caption).toContain("6 of 34 Nashville areas checked.");
    const shared = body(a, "second", "more-less");
    expect(shared.body.heads).toEqual(["Both have more of", "Both have less of"]);
    expect(shared.body.more[0]).toMatchObject({ label: "Coffee house", display: "+31 / +27" });
    const econ = body(a, "third", "rows");
    expect(econ.body.rows.at(-1)).toMatchObject({ label: "Nashville, all areas", comparison: true });
    expect(econ.body.rows[0]?.cells).toEqual(["11,840", "33.1", "$68.4K", "19.0%"]);
    expect(econ.caption).toMatch(/residents .*not customers, foot traffic or spending/);
    expect(words(a)[0]).toBe("East Nashville | Closest twin | Match 0.71, a close match, best of the 5 areas that could be matched (1.00 = the same mix of tastes)");
    expect(a.verdict.check?.text).toMatch(/against Qloo and Census data$/);
  });

  it("brand_collab: partners on one scale, the tags the audiences share, and plain fit numbers", () => {
    const a = answer("brand_collab");
    const partners = body(a, "main", "bars");
    expect(partners.body.rows.map((r) => r.display).slice(0, 2)).toEqual(["94/100", "91/100"]);
    expect(body(a, "second", "neighbours").body.columns.map((c) => c.label)).toEqual(["Only Larkfield Soda", "Both audiences", "Only Copperline Coffee"]);
    expect(words(a)).toEqual([
      "Copperline Coffee | Best-fit partner | Fit 94/100, #1 of the 6 brands scored on one scale",
      "Fieldnote Outfitters | Next best | Fit 91/100, #2 of the 6 brands scored on one scale",
      "5 of 14 | Audience tags they share | tags listed for either brand that both audiences carry",
    ]);
  });

  it("creator_fit: one column per kind of creator, and a top pick per kind that never compares kinds", () => {
    const a = answer("creator_fit");
    expect(body(a, "main", "neighbours").body.columns.map((c) => c.label)).toEqual(["Public figures", "Music", "Podcasts"]);
    expect(a.charts.main?.caption).toContain("scores compare only within a kind");
    expect(a.keyNumbers.map((k) => k.label)).toEqual(["Top pick: Public figures", "Top pick: Music", "Top pick: Podcasts"]);
  });

  it("launch_test: kept, found and dropped guesses, a drop never linked as a pick, financials apart, and the part not covered at the top", () => {
    const a = answer("launch_test");
    const verdicts = body(a, "main", "verdicts");
    expect(verdicts.body.groups.map((g) => g.verdict)).toEqual(["keep", "add", "veto", "unscored"]);
    const dropped = verdicts.body.groups.find((g) => g.verdict === "veto");
    expect(dropped?.title).toBe("Dropped: the data does not back these");
    for (const r of dropped?.rows ?? []) expect(r.href).toBeNull();
    expect(dropped?.rows[0]?.display).toBe("vetoed: scores below the concept's 50th result");
    expect(verdicts.body.groups[0]?.rows[0]).toMatchObject({ label: "Red Mesa Pantry", display: "#12 for the concept" });
    const fin = body(a, "third", "rows");
    expect(fin.body.rows.find((r) => r.label === "FY2025")).toMatchObject({ sublabel: "10-K filed 2026-02-19", cells: ["$1.4B", "39.2%", "12.1%", "6.2%"] });
    expect(fin.body.rows[0]?.cells[3]).toBe("Not reported");
    expect(fin.caption).toContain("Not advice.");
    expect(a.verdict.advice).toBe("Taste signals, not buy or sell advice.");
    expect(a.readAs).toEqual({
      jobLabel: "Test a new product",
      notCovered: ["pricing"],
      text: "Not covered: pricing. We have no data on this, so this answer leaves it out.",
    });
    // Said once, at the top: the limitation does not repeat under "What could change this".
    expect(a.changes.join(" ")).not.toContain("pricing");
    expect(words(a)[0]).toBe("3 of 5 | AI guesses the data backs | scored at least as high as the concept's 50th result (its last, when fewer come back)");
  });

  it("city_compare: every city's fingerprint in one card, against the other map cities, and residents per city", () => {
    const a = answer("city_compare");
    expect(a.head.eyebrow).toContain("Austin, Nashville and Denver");
    const prints = body(a, "main", "neighbours");
    expect(prints.body.columns.map((c) => c.label)).toEqual(["Austin", "Nashville", "Denver"]);
    expect(prints.caption).toContain("than the other cities we map");
    // The other fingerprints are drawn in that card, so they are not listed again under More charts.
    expect(a.more).toEqual([]);
    expect(words(a)[0]).toBe("Natural wine | Austin stands out for | ranks 34 places higher here than in the other cities we map");
    body(a, "third", "rows");
  });

  it("a question that fit its job has no Read as note", () => {
    for (const job of Job.options.filter((j) => j !== "launch_test")) expect(answer(job).readAs, job).toBeNull();
  });
});

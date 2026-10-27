// Every job end to end (PLAN Part 5 "Done when"): the scripted fake ANALYST over the real Qloo client
// on the mock transport, with the pinned market localities the mock resolves. Each run must complete
// with at least one ANALYST PIVOT, on a finding its job's playbook lists (director.md §5), and no
// CHECKER issue. Invented entities only (D29).
import {
  FindingKind,
  Report,
  type EventInput,
  type EventInputOf,
  type Intent,
  type Job,
  type LocalityApi,
  type MarketId,
  type MetroId,
  type ModelDigest,
  type ReportDraftShape,
  type SubmitPlanInputShape,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { AnalystRequest } from "../../src/anthropic";
import { NOTICE_FOLLOWUP_OPEN, TURN3_NOTICE } from "../../src/llm/notices";
import { DIRECTOR_PROMPT } from "../../src/prompts";
import { gazetteer } from "../../src/run/gazetteer";
import { MARKET_CATALOGUE } from "../../src/run/markets";
import type { StreamScript } from "../support/fake-anthropic";
import { digestsIn, userTexts as userTextsOf, intentFor, mockQloo, parseAll, planCall, reportCall, respond, run, toolUse } from "./support";

/** Markets kv pins in these runs: the mock's locality for each, found by exact name as ops would pin it. */
const PINNED: readonly MarketId[] = ["nashville", "austin", "denver", "chicago", "atlanta", "boise"];

async function mockLocalities(pinned: readonly MarketId[] = PINNED): Promise<LocalityApi> {
  const lookup = mockQloo().standalone().forTool(null);
  const pins = new Map<MarketId, { entityId: string; label: string }>();
  for (const id of pinned) {
    const market = MARKET_CATALOGUE.find((m) => m.id === id)!;
    const { data } = await lookup.search({ query: market.query, types: ["urn:entity:locality"], take: 5 });
    const hit = data.results.find((r) => r.name === market.query);
    if (hit === undefined) throw new Error(`the mock has no locality named ${market.query}`);
    pins.set(id, { entityId: hit.entity_id, label: market.label });
  }
  return { market: async (id) => pins.get(id) ?? null };
}

// Reading what the model has seen ------------------------------------------------------------------------

type Seen = { metrics: string[]; evidence: string[]; datasets: string[]; findings: { id: string; kind: string }[] };

/** Ids a draft may cite: ok digests' evidence and datasets, and metrics with a value that need no window token. */
function seen(req: AnalystRequest): Seen {
  const digests = digestsIn(req);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const ok = digests.filter((d) => d.status === "ok" || d.status === "partial");
  return {
    metrics: uniq(ok.flatMap((d) => d.metrics.filter((m) => m.badge !== "UNAVAILABLE" && m.badge !== "STALE").map((m) => m.id))),
    evidence: uniq(ok.flatMap((d) => d.evidence_ids)),
    datasets: uniq(ok.flatMap((d) => d.dataset_ids)),
    findings: digests.flatMap((d) => d.findings.map((f) => ({ id: f.id, kind: f.kind }))),
  };
}

/** The pivots a job's playbook lists (its director.md §5 line), e.g. LATENT_DEMAND for site_selection. */
function playbookPivots(job: Job): FindingKind[] {
  const line = DIRECTOR_PROMPT.split("\n").find((l) => l.startsWith(`- **${job}** (`)) ?? "";
  return FindingKind.options.filter((k) => line.includes(k));
}

/** The first finding of these kinds, in this order; a run without one fails, whatever else it raised. */
function findingOf(req: AnalystRequest, kinds: readonly FindingKind[]): { id: string; kind: string } {
  const all = seen(req).findings;
  const found = kinds.flatMap((k) => all.filter((f) => f.kind === k))[0];
  if (found === undefined) {
    const summary = digestsIn(req).map((d) => ({ status: d.status, flags: d.flags, notices: d.notices, rows: d.top_rows.length, metrics: d.metrics.length }));
    const raised = all.map((f) => f.kind).join(", ") || "none";
    throw new Error(`no ${kinds.join(" or ")} finding to pivot on (raised: ${raised}): ${JSON.stringify(summary)} ${userTextsOf(req).filter((t) => !t.includes("qloo_data")).join(" | ").slice(0, 600)}`);
  }
  return found;
}

const registered = (digests: readonly ModelDigest[], type: string) =>
  digests.flatMap((d) => d.registered.filter((r) => r.type === type).map((r) => r.ref));

/** A draft that passes every CHECKER rule, citing only what the model has seen. */
function draftFor(ids: Seen, subject: string, nextMoves: ReportDraftShape["next_moves"]): ReportDraftShape {
  if (ids.metrics.length < 3 || ids.evidence.length === 0) throw new Error(`too little evidence to report: ${JSON.stringify(ids)}`);
  const m = (i: number) => ids.metrics[i % ids.metrics.length]!;
  const e = (i: number) => ids.evidence[i % ids.evidence.length]!;
  const argument = (i: number, section: "opportunity" | "competition" | "risk") => ({
    id: `A${i + 1}`,
    section,
    qloo_fact: `The run measures {{${m(i)}}} [${e(i)}].`,
    our_read: `This shapes the read on ${subject} for the decision at hand.`,
    metric_ids: [m(i)],
    evidence_ids: [e(i)],
  });
  return {
    headline: `${subject}: the taste evidence points one clear way`,
    signal: "mixed",
    verdict_tag: "Clear lead",
    thesis: `The scan and the pivot agree on the main read {{${m(0)}}} [${e(0)}].`,
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: [m(0)], note: `Measured {{${m(0)}}}.` },
      { hypothesis_id: "H2", verdict: "inconclusive", metric_ids: [m(1)], note: `Closest measure {{${m(1)}}}.` },
    ],
    arguments: [argument(0, "opportunity"), argument(1, "competition"), argument(2, "risk")],
    exhibits: ids.datasets.slice(0, 3).map((d) => ({ dataset_id: d, title: "Evidence", caption: "What the run measured." })),
    bear_case: [{ text: `A wider set could change the read {{${m(1)}}}.`, metric_ids: [m(1)] }],
    recommendations: [{ action: "Test the lead with a small pilot first.", priority: "next", argument_ids: ["A1"] }],
    next_moves: nextMoves,
    open_questions: [],
  };
}

function plan(question: string, steps: SubmitPlanInputShape["steps"], tool: SubmitPlanInputShape["hypotheses"][number]["test_tool"]): SubmitPlanInputShape {
  return {
    restated_question: question,
    hypotheses: [
      { id: "H1", statement: "The lead is clear in the first measure.", expectation: "One option ranks first.", test_tool: tool, metric_hint: "rank" },
      { id: "H2", statement: "The lead holds in a second measure.", expectation: "The same option leads.", test_tool: tool, metric_hint: "rank" },
    ],
    steps,
    assumptions: ["US geography"],
  };
}

const step = (id: string) => ({ trigger_finding_id: null, step_id: id });
const pivotOn = (finding: { id: string }) => ({ trigger_finding_id: finding.id, step_id: null });

// Running ------------------------------------------------------------------------------------------------

type Of<T extends EventInput["type"]> = EventInputOf<T>;
const ofType = <T extends EventInput["type"]>(events: readonly EventInput[], type: T): Of<T>[] =>
  events.filter((e): e is Of<T> => e.type === type);

interface JobCase {
  question: string;
  intent: Intent;
  stream: StreamScript[];
}

async function runJob(c: JobCase & { pinned?: readonly MarketId[] }) {
  const harness = await run({ intent: c.intent, question: c.question, stream: c.stream, localities: await mockLocalities(c.pinned) });
  const { result, events } = harness;
  parseAll(events);
  expect(result.reason).toBeNull();
  expect(result.status).toBe("completed");
  // At least one ANALYST PIVOT, carried out: its finding is one the job's playbook pivots on, and its call ran.
  const pivots = ofType(events, "pivot");
  expect(pivots.length).toBeGreaterThan(0);
  const playbook = playbookPivots(c.intent.job);
  expect(playbook.length, c.intent.job).toBeGreaterThan(0);
  for (const p of pivots) {
    const finding = ofType(events, "finding").find((f) => f.finding.id === p.triggerFindingId)?.finding;
    expect(playbook, `${c.intent.job} pivots on ${finding?.kind}`).toContain(finding?.kind);    expect(ofType(events, "tool.end").find((e) => e.toolCallId === p.toolCallId)).toMatchObject({ ok: true });
  }
  // No CHECKER issue on any attempt, and no refused tool call.
  const validations = ofType(events, "validation");
  expect(validations.map((v) => ({ ok: v.ok, issues: v.issues }))).toEqual([{ ok: true, issues: [] }]);
  expect(ofType(events, "tool.end").filter((e) => e.error?.code === "invalid_tool_input")).toEqual([]);
  const report = Report.parse(result.report);
  expect(report.incomplete).toBe(false);
  expect(report.warnings).toEqual([]);
  expect(report.exhibits[0]?.kind).toBe("Scorecard");
  expect(report.kpis.length).toBeGreaterThan(0);
  expect(report.verdict.signal).toBe("mixed");
  return { ...harness, report };
}

const ASK = (label: string, question: string) => ({ label, question });

/** Turn 3: the report, citing what the model has seen. */
const reportTurn =
  (subject: string, nextMoves: ReportDraftShape["next_moves"]): StreamScript =>
  (req) =>
    respond([reportCall("toolu_report", draftFor(seen(req), subject, nextMoves))]);

/** A neighbourhood of the shipped gazetteer as an area argument, matched by name as the scan matches CLERK's area. */
function areaArg(metro: MetroId, name: string) {
  const nbhd = gazetteer().matchNeighbourhood(metro, name);
  if (nbhd === null) throw new Error(`the ${metro} gazetteer has no ${name}`);
  return { kind: "nbhd" as const, ref: nbhd.id, metro };
}

// The eight jobs -----------------------------------------------------------------------------------------

describe("every job runs end to end with a pivot and no CHECKER issue", () => {
  it("brand_health: momentum in wave 1, the planned Share-of-Taste grid and a pivot in turn 2, the Taste Position card", async () => {
    const question = "Is Brand Alpha's audience a moat or a niche?";
    const { report, result } = await runJob({
      question,
      intent: intentFor(),
      stream: [
        respond([
          planCall(
            plan(question, [
              { id: "S1", tool: "momentum", purpose: "Taste-signal momentum of Brand Alpha." },
              { id: "S2", tool: "share_of_taste", purpose: "Where Brand Alpha and its map's peers win, by age and market." },
            ], "peer_landscape"),
          ),
          toolUse("toolu_mom", "momentum", { entities: ["R1"], type: "brand", ...step("S1") }),
        ]),
        (req) => {
          const peers = registered(digestsIn(req, "SUBS"), "brand").filter((r) => r !== "R1").slice(0, 2);
          const finding = findingOf(req, ["OUTSIDE_CATEGORY_NEIGHBOUR", "TASTE_ISLAND", "NEAR_SUBSTITUTES"]);
          return respond([
            toolUse("toolu_share", "share_of_taste", {
              type: "brand",
              set: ["R1", ...peers],
              ages: ["24_and_younger", "35_to_44", "55_and_older"],
              audiences: [],
              metros: ["nashville", "austin"],
              ...step("S2"),
            }),
            toolUse("toolu_pivot", "cross_domain", { seeds: ["R1"], seed_tags: [], domains: ["podcast"], popularity_max: 0.85, ...pivotOn(finding) }),
          ]);
        },
        reportTurn("Brand Alpha", [
          ASK("Who the fans are", "Who is the Brand Alpha audience?"),
          ASK("Where to launch next", "Which cities should Brand Alpha launch in next?"),
        ]),
      ],
    });
    expect(report.exhibits[1]).toMatchObject({ kind: "Position", viz: "PositionCard" });
    const position = result.ledger.datasets.find((d) => d.kind === "Position");
    expect(position?.kind === "Position" && position.payload.axes.filter((a) => a.value !== null).length).toBeGreaterThanOrEqual(3);
  });

  it("head_to_head: the duel scan in a named metro, momentum in wave 1, a pivot on the duel's finding", async () => {
    const question = "Brand Alpha vs Brand Beta in Austin: same customer, and who wins where?";
    const intent = intentFor({
      job: "head_to_head",
      mentions: [
        { text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false },
        { text: "Brand Beta", entity_type: "brand", role: "peer", public_figure: false },
      ],
      geo: { metro: "austin", area: null, unsupported_place: null, market: null },
      mnemonic: "BRAND ALPHA VS BRAND BETA",
    });
    const { report, events, result } = await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "momentum", purpose: "Momentum of both brands." }], "share_of_taste")),
          toolUse("toolu_mom", "momentum", { entities: ["R1", "R2"], type: "brand", ...step("S1") }),
        ]),
        (req) => {
          const finding = findingOf(req, ["GENERATIONAL_SPLIT", "NEAR_SUBSTITUTES", "METRO_OUTLIER"]);
          return respond([
            toolUse("toolu_pivot", "cross_domain", { seeds: ["R1", "R2"], seed_tags: [], domains: ["artist"], popularity_max: 0.85, ...pivotOn(finding) }),
          ]);
        },
        reportTurn("Brand Alpha and Brand Beta", [
          ASK("Who the Alpha fans are", "Who is the Brand Alpha audience?"),
          ASK("An Austin storefront", "Which brands fit a storefront in East Cesar Chavez, Austin?"),
        ]),
      ],
    });
    expect(report.exhibits[1]).toMatchObject({ kind: "Position" });
    // The strip leads with the duel's similarity, not the subject's nearest audience on the map.
    const lead = result.ledger.metrics.find((m) => m.id === report.kpis[0]?.metricId);
    expect(lead?.key).toBe("subs.similarity");
    expect([...(lead?.subjectRefs ?? [])].sort()).toEqual(["R1", "R2"]);
    // The scan ranked the pair in the named metro and read the set across markets.
    const scanTools = ofType(events, "tool.start").filter((e) => e.phase === "scan").map((e) => e.tool);
    expect(scanTools).toEqual(["peer_landscape", "rank_candidates", "share_of_taste", "audience_dna"]);
  });

  it("site_selection: the concept heatmap chained after find_tags, a pivot to the top pocket's Block DNA", async () => {
    const question = "Where in Austin should I open a coffee shop?";
    const intent = intentFor({
      job: "site_selection",
      pillar: "location",
      mentions: [],
      geo: { metro: "austin", area: null, unsupported_place: null, market: null },
      constraints: { concepts: ["coffee shop"], sponsor_categories: [], domains: [], ages: [], notes: [] },
      mnemonic: "COFFEE SHOP SITE AUSTIN",
    });
    const { report, events } = await runJob({
      question,
      intent,
      stream: [
        respond([planCall(plan(question, [{ id: "S1", tool: "block_dna", purpose: "Profile the top pocket against the city." }], "geo_lift"))]),
        (req) => {
          const lift = digestsIn(req, "LIFT")[0];
          const area = lift?.top_rows.find((r) => r.values.lift_rank === 1)?.values.area;
          if (typeof area !== "string") throw new Error("the scan's lift map ranked no neighbourhood");
          const finding = findingOf(req, ["LATENT_DEMAND"]);
          return respond([toolUse("toolu_pivot", "block_dna", { area: { kind: "nbhd", ref: area, metro: "austin" }, include_brands: true, ...pivotOn(finding) })]);
        },
        reportTurn("Coffee in Austin", [
          ASK("Tenants for the pocket", "Which brands fit a storefront in the top Austin pocket for coffee?"),
          ASK("Zilker's taste profile", "What is the taste profile of the Zilker neighbourhood in Austin?"),
        ]),
      ],
    });
    const scan = ofType(events, "tool.start").filter((e) => e.phase === "scan");
    expect(scan.map((e) => [e.toolCallId, e.tool])).toEqual([
      ["scan-1", "find_tags"],
      ["scan-2", "geo_lift"],
    ]);
    expect(report.kpis.some((k) => report.exhibits.length > 0 && k.label.startsWith("lift of"))).toBe(true);
  });

  it("area_profile: Block DNA in the scan, local brands ranked site vs city as the pivot", async () => {
    const question = "What makes Barton Hills' taste different from the rest of Austin?";
    const intent = intentFor({
      job: "area_profile",
      pillar: "location",
      mentions: [],
      geo: { metro: "austin", area: "Barton Hills", unsupported_place: null, market: null },
      mnemonic: "BARTON HILLS, AUSTIN DNA",
    });
    await runJob({
      question,
      intent,
      stream: [
        respond([planCall(plan(question, [{ id: "S1", tool: "rank_candidates", purpose: "Rank the local brands here against the city." }], "block_dna"))]),
        (req) => {
          const block = digestsIn(req, "BLOCK")[0];
          const brands = (block?.registered ?? []).filter((r) => r.type === "brand").map((r) => r.ref).slice(0, 6);
          return respond([
            toolUse("toolu_pivot", "rank_candidates", {
              type: "brand",
              candidates: brands,
              signal_entities: [],
              signal_tags: [],
              contexts: [
                { kind: "site", area: areaArg("austin", "Barton Hills") },
                { kind: "city", metro: "austin" },
              ],
              ...pivotOn(findingOf(req, ["BLOCK_NEW_TAGS"])),
            }),
          ]);
        },
        reportTurn("Barton Hills", [
          ASK("Tenants for the block", "Which brands fit a vacant storefront in Barton Hills, Austin?"),
          ASK("Where a cocktail bar fits", "Which Austin neighbourhood suits a cocktail bar?"),
        ]),
      ],
    });
  });

  it("tenant_mix: resolved tenant brands in wave 1, ranked site vs city with the local brands as the pivot", async () => {
    const question = "Which brands would fit a vacant storefront in Hermitage, Nashville, and what is the street saturated with?";
    const intent = intentFor({
      job: "tenant_mix",
      pillar: "location",
      mentions: [],
      geo: { metro: "nashville", area: "Hermitage", unsupported_place: null, market: null },
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: ["vacant storefront"] },
      mnemonic: "HERMITAGE, NASHVILLE TEN",
    });
    const { report } = await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "resolve_entities", purpose: "Resolve the tenant brands the priors name." }], "rank_candidates")),
          toolUse("toolu_res", "resolve_entities", {
            mentions: [
              { text: "Brand Gamma", type: "brand", metro: null },
              { text: "Brand Delta", type: "brand", metro: null },
            ],
            ...step("S1"),
          }),
        ]),
        (req) => {
          const resolved = registered(digestsIn(req, "RES"), "brand");
          const local = registered(digestsIn(req, "BLOCK"), "brand");
          return respond([
            toolUse("toolu_pivot", "rank_candidates", {
              type: "brand",
              candidates: [...new Set([...resolved, ...local])].slice(0, 8),
              signal_entities: [],
              signal_tags: [],
              contexts: [
                { kind: "site", area: areaArg("nashville", "Hermitage") },
                { kind: "city", metro: "nashville" },
              ],
              ...pivotOn(findingOf(req, ["BLOCK_NEW_TAGS"])),
            }),
          ]);
        },
        reportTurn("The Hermitage storefront", [
          ASK("The block's own taste", "What makes the Hermitage neighbourhood's taste different from Nashville?"),
          ASK("The lead tenant's fans", "Who is the Brand Gamma audience?"),
        ]),
      ],
    });
    expect(report.kpis.map((k) => k.label).some((l) => l.startsWith("tenant fit of"))).toBe(true);
  });

  it("sponsorship: the slate in the named tour markets, travel taste and expected brands in wave 1, the playbook's move on the slate's finding", async () => {
    const question = "Which beer and energy-drink brands fit Artist Lumen's tour through Dallas and Miami?";
    const intent = intentFor({
      job: "sponsorship",
      pillar: "marketing",
      mentions: [{ text: "Artist Lumen", entity_type: "artist", role: "primary", public_figure: false }],
      constraints: { concepts: [], sponsor_categories: ["beer", "energy_drinks"], domains: [], ages: [], notes: ["markets: Dallas, Miami", "tour"] },
      mnemonic: "ARTIST LUMEN <ARTIST> SPON",
    });
    const { events } = await runJob({
      question,
      pinned: [...PINNED, "dallas", "miami"],
      intent,
      stream: [
        respond([
          planCall(
            plan(question, [
              { id: "S1", tool: "destination_affinity", purpose: "Where the fans' travel taste points." },
              { id: "S2", tool: "resolve_entities", purpose: "Resolve the brands the priors expect on the slate." },
            ], "sponsor_slate"),
          ),
          toolUse("toolu_trvl", "destination_affinity", { seeds: ["R1"], ...step("S1") }),
          toolUse("toolu_res", "resolve_entities", {
            mentions: [
              { text: "Brand Gamma", type: "brand", metro: null },
              { text: "Brand Delta", type: "brand", metro: null },
            ],
            ...step("S2"),
          }),
        ]),
        (req) => {
          // The playbook's move per finding: the slate again with the resolved brands, or cross_domain near 0.85.
          const finding = findingOf(req, ["DROPPED_CANDIDATES", "POPULARITY_DOMINANCE"]);
          if (finding.kind === "DROPPED_CANDIDATES") {
            const shortlist = registered(digestsIn(req, "RES"), "brand");
            if (shortlist.length === 0) throw new Error("wave 1 resolved no brand for the shortlist");
            return respond([
              toolUse("toolu_pivot", "sponsor_slate", {
                seed: "R1",
                categories: ["beer", "energy_drinks"],
                shortlist,
                markets: ["dallas", "miami"],
                ...pivotOn(finding),
              }),
            ]);
          }
          return respond([
            toolUse("toolu_pivot", "cross_domain", { seeds: ["R1"], seed_tags: [], domains: ["brand"], popularity_max: 0.85, ...pivotOn(finding) }),
          ]);
        },
        reportTurn("Artist Lumen", [
          ASK("Where to add dates", "Which markets should Artist Lumen add tour dates in?"),
          ASK("A Nashville block", "Which East Nashville block fits an Artist Lumen after-party pop-up?"),
        ]),
      ],
    });
    const slate = ofType(events, "tool.start").find((e) => e.tool === "sponsor_slate");
    expect(slate).toMatchObject({ phase: "scan", args: { markets: ["dallas", "miami"], categories: ["beer", "energy_drinks"] } });
    // The pivot made the move the playbook names for its finding.
    const pivot = ofType(events, "pivot")[0];
    const kind = ofType(events, "finding").find((f) => f.finding.id === pivot?.triggerFindingId)?.finding.kind;
    expect(pivot?.tool).toBe(kind === "DROPPED_CANDIDATES" ? "sponsor_slate" : "cross_domain");
  });

  it("market_selection: travel taste and the market grid in the scan, an implied peer in wave 1, a pivot on the grid", async () => {
    const question = "Where should Comedian Vega and Comedian Rhea add dates? Denver and Boise are on the list.";
    const intent = intentFor({
      job: "market_selection",
      pillar: "marketing",
      mentions: [
        { text: "Comedian Vega", entity_type: "person", role: "primary", public_figure: true },
        { text: "Comedian Rhea", entity_type: "person", role: "peer", public_figure: true },
      ],
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: ["markets: Denver, Boise"] },
      mnemonic: "COMEDIAN VEGA <PERSON> MKTS",
    });
    const { events } = await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "resolve_entities", purpose: "Resolve another comedian the prior expects." }], "share_of_taste")),
          toolUse("toolu_res", "resolve_entities", { mentions: [{ text: "Comedian Orion", type: "person", metro: null }], ...step("S1") }),
        ]),
        (req) => {
          const peers = registered(digestsIn(req, "RES"), "person");
          return respond([
            toolUse("toolu_pivot", "share_of_taste", {
              type: "person",
              set: ["R1", "R2", ...peers].slice(0, 8),
              ages: [],
              audiences: [],
              metros: ["denver", "boise"],
              ...pivotOn(findingOf(req, ["METRO_OUTLIER", "DROPPED_CANDIDATES"])),
            }),
          ]);
        },
        reportTurn("Comedian Vega", [
          ASK("A Nashville block", "Which East Nashville block fits a Comedian Vega pop-up show?"),
          ASK("Sponsors for the run", "Which brands should sponsor Comedian Vega's tour?"),
        ]),
      ],
    });
    const grid = ofType(events, "tool.start").find((e) => e.tool === "share_of_taste" && e.phase === "scan");
    expect(grid?.args).toMatchObject({ type: "person", set: ["R1", "R2"], metros: ["denver", "boise", "nashville", "austin", "chicago", "atlanta"] });
  });

  it("audience_discovery: the cultural neighbourhood and Audience DNA, travel taste in wave 1, a pivot for under-the-radar picks", async () => {
    const question = "Who is the Brand Delta audience, and what else do they love?";
    const intent = intentFor({
      job: "audience_discovery",
      pillar: "audience",
      mentions: [{ text: "Brand Delta", entity_type: "brand", role: "primary", public_figure: false }],
      mnemonic: "BRAND DELTA <BRAND> AUD",
    });
    await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "destination_affinity", purpose: "Where the audience's travel taste points." }], "cross_domain")),
          toolUse("toolu_trvl", "destination_affinity", { seeds: ["R1"], ...step("S1") }),
        ]),
        (req) =>
          respond([
            toolUse("toolu_pivot", "cross_domain", {
              seeds: ["R1"],
              seed_tags: [],
              domains: ["podcast"],
              popularity_max: 0.85,
              ...pivotOn(findingOf(req, ["POPULARITY_DOMINANCE", "GENERATIONAL_SPLIT"])),
            }),
          ]),
        reportTurn("The Brand Delta audience", [
          ASK("Sponsor fit", "Which sponsors fit Artist Nova, whose fans overlap Brand Delta's?"),
          ASK("Moat or niche", "Is Brand Delta's audience a moat or a niche against its peers?"),
        ]),
      ],
    });
  });
});

describe("pivots on findings a turn-2 step leaves standing or a deferred scan step raises", () => {
  const FOLLOWUPS = /FOLLOW-UPS WORTH RUNNING: (F\d+) \([a-z -]+\) suggests ([a-z_]+)(?: on ([^;.(]+?))?(?: with ([^;.(]+?))?(?: \(|;|\. )/;
  /** The first follow-up the latest FOLLOW-UPS WORTH RUNNING line lists: finding, tool, ids it is on and tags it runs with. */
  function listed(req: AnalystRequest): { finding: string; tool: string; on: string[]; with: string[] } {
    const match = userTextsOf(req)
      .flatMap((t) => (t.startsWith("FOLLOW-UPS WORTH RUNNING") ? [FOLLOWUPS.exec(t)] : []))
      .filter((m) => m !== null)
      .at(-1);
    if (!match) throw new Error("no FOLLOW-UPS WORTH RUNNING line");
    const ids = (group: string | undefined) => (group ?? "").split(", ").filter((id) => id !== "");
    return { finding: match[1]!, tool: match[2]!, on: ids(match[3]), with: ids(match[4]) };
  }

  it("tenant_mix: turn 2 spends its response on the planned ranking, stays open with the BLOCK_NEW_TAGS lead, and the pivot ranks on its tags", async () => {
    const question = "Which brands would fit a vacant storefront in Hermitage, Nashville, and what is the street saturated with?";
    const intent = intentFor({
      job: "tenant_mix",
      pillar: "location",
      mentions: [],
      geo: { metro: "nashville", area: "Hermitage", unsupported_place: null, market: null },
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: ["vacant storefront"] },
      mnemonic: "HERMITAGE, NASHVILLE TEN",
    });
    const contexts = [
      { kind: "site", area: areaArg("nashville", "Hermitage") },
      { kind: "city", metro: "nashville" },
    ];
    const localBrands = (req: AnalystRequest) => registered(digestsIn(req, "BLOCK"), "brand").slice(0, 6);
    const { events, fake } = await runJob({
      question,
      intent,
      stream: [
        respond([planCall(plan(question, [{ id: "S1", tool: "rank_candidates", purpose: "Rank the local brands at the site against the city." }], "rank_candidates"))]),
        // The planned step as written, with no signal: the lead named when turn 1 closed is not taken up.
        (req) =>
          respond([
            toolUse("toolu_step", "rank_candidates", { type: "brand", candidates: localBrands(req), signal_entities: [], signal_tags: [], contexts, ...step("S1") }),
          ]),
        (req) => {
          const lead = listed(req);
          return respond([
            toolUse("toolu_pivot", lead.tool, {
              type: "brand",
              candidates: localBrands(req),
              signal_entities: [],
              signal_tags: lead.with.slice(0, 3),
              contexts,
              ...pivotOn({ id: lead.finding }),
            }),
          ]);
        },
        reportTurn("The Hermitage storefront", [
          ASK("The block's own taste", "What makes the Hermitage neighbourhood's taste different from Nashville?"),
          ASK("A tenant's fans", "Who is the audience of the block's top local brand?"),
        ]),
      ],
    });
    // Turn 1 closed with the lead on the NEW tags (no area or city among its ids) and the step it would replace.
    const first = listed(fake.streamRequests[1]!);
    expect(first).toMatchObject({ tool: "rank_candidates", on: [] });
    expect(first.with.length).toBeGreaterThan(0);
    expect(userTextsOf(fake.streamRequests[1]!).find((t) => t.startsWith("FOLLOW-UPS"))).toContain("S1 plans rank_candidates");
    // After the planned step, turn 2 stayed open with the lead as it then stood, in place of TURN 3.
    expect(userTextsOf(fake.streamRequests[2]!).at(-1)).toBe(NOTICE_FOLLOWUP_OPEN);
    expect(listed(fake.streamRequests[2]!)).toEqual(first);
    expect(userTextsOf(fake.streamRequests[3]!).at(-1)).toBe(TURN3_NOTICE);
    const pivot = ofType(events, "pivot")[0];
    expect(pivot).toMatchObject({ toolCallId: "toolu_pivot", tool: "rank_candidates", args: expect.objectContaining({ signal_tags: first.with.slice(0, 3) }) });
    expect(ofType(events, "finding").find((f) => f.finding.id === pivot?.triggerFindingId)?.finding.kind).toBe("BLOCK_NEW_TAGS");
    expect(ofType(events, "tool.start").filter((e) => e.phase === "followup").map((e) => [e.toolCallId, e.stepId])).toEqual([
      ["toolu_step", "S1"],
      ["toolu_pivot", null],
    ]);
  });

  it("market_selection: the peers wave 1 resolves feed the market grid before turn 1 closes, and its finding drives the pivot", async () => {
    const question = "Comedian Vega wants new dates. Where does the audience out-index other comedians?";
    const intent = intentFor({
      job: "market_selection",
      pillar: "marketing",
      mentions: [{ text: "Comedian Vega", entity_type: "person", role: "primary", public_figure: true }],
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: ["new dates"] },
      mnemonic: "COMEDIAN VEGA <PERSON> MKTS",
    });
    const { events, fake } = await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "resolve_entities", purpose: "Resolve the comedians the prior compares." }], "share_of_taste")),
          toolUse("toolu_res", "resolve_entities", {
            mentions: [
              { text: "Comedian Rhea", type: "person", metro: null },
              { text: "Comedian Orion", type: "person", metro: null },
            ],
            ...step("S1"),
          }),
        ]),
        (req) => {
          const grid = digestsIn(req, "SHARE")[0];
          if (grid === undefined) throw new Error("the market grid did not reach turn 2");
          const set = grid.top_rows.flatMap((r) => (r.ref !== null && r.ref.startsWith("R") ? [r.ref] : []));
          const finding = findingOf(req, ["METRO_OUTLIER", "DROPPED_CANDIDATES"]);
          return respond([
            toolUse("toolu_pivot", "share_of_taste", {
              type: "person",
              set: [...new Set(set)].slice(0, 8),
              ages: ["24_and_younger", "55_and_older"],
              audiences: [],
              metros: [],
              ...pivotOn(finding),
            }),
          ]);
        },
        reportTurn("Comedian Vega", [
          ASK("A Nashville block", "Which East Nashville block fits a Comedian Vega pop-up show?"),
          ASK("Sponsors for the run", "Which brands should sponsor Comedian Vega's tour?"),
        ]),
      ],
    });
    // The first message says the grid waits for wave 1's peers.
    expect(userTextsOf(fake.streamRequests[0]!)[0]).toMatch(
      /- share_of_taste \(SHARE\) for R1 and the person peers your wave-1 resolve_entities registers, by markets [a-z_, ]+: runs once your wave-1 calls return/,
    );
    // It ran as a scan step once wave 1 had resolved the peers, on the primary and those peers.
    const grid = ofType(events, "tool.start").find((e) => e.tool === "share_of_taste" && e.phase === "scan");
    const resolved = ofType(events, "resolve")
      .flatMap((r) => r.entities)
      .flatMap((e) => (e.ref !== null && e.ref !== "R1" ? [e.ref] : []));
    expect(resolved.length).toBeGreaterThan(0);
    expect(grid).toMatchObject({ toolCallId: "scan-2", args: { type: "person", set: ["R1", ...resolved] } });
    const order = events.map((e) => (e.type === "tool.end" || e.type === "tool.start" ? `${e.type} ${e.toolCallId}` : ""));
    expect(order.indexOf("tool.start scan-2")).toBeGreaterThan(order.indexOf("tool.end toolu_res"));
    // Its digest and finding came with turn 1's close, and the turn-2 pivot ran in full on the follow-up allowance.
    expect(digestsIn(fake.streamRequests[1]!, "SHARE")).toHaveLength(1);
    const pivotEnd = ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_pivot");
    expect(pivotEnd?.ok).toBe(true);
    expect(pivotEnd?.flags).not.toContain("BUDGET_TRUNCATED");
  });

  it("audience_discovery: with no peer from wave 1, the read by age runs on the scan's own brand neighbours", async () => {
    const question = "Which podcasts fit Brand Delta's audience?";
    const intent = intentFor({
      job: "audience_discovery",
      pillar: "audience",
      mentions: [{ text: "Brand Delta", entity_type: "brand", role: "primary", public_figure: false }],
      constraints: { concepts: [], sponsor_categories: [], domains: ["podcast"], ages: [], notes: [] },
      mnemonic: "BRAND DELTA <BRAND> AUD",
    });
    const { events, fake } = await runJob({
      question,
      intent,
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "destination_affinity", purpose: "Where the audience's travel taste points." }], "cross_domain")),
          toolUse("toolu_trvl", "destination_affinity", { seeds: ["R1"], ...step("S1") }),
        ]),
        (req) =>
          respond([
            toolUse("toolu_pivot", "cross_domain", {
              seeds: ["R1"],
              seed_tags: [],
              domains: ["podcast"],
              popularity_max: 0.85,
              ...pivotOn(findingOf(req, ["POPULARITY_DOMINANCE", "GENERATIONAL_SPLIT"])),
            }),
          ]),
        reportTurn("The Brand Delta audience", [
          ASK("Sponsor fit", "Which sponsors fit Artist Nova, whose fans overlap Brand Delta's?"),
          ASK("Moat or niche", "Is Brand Delta's audience a moat or a niche against its peers?"),
        ]),
      ],
    });
    // The scan read the named podcasts and the target's own type, and the brand rows became the age read's set.
    const scan = ofType(events, "tool.start").filter((e) => e.phase === "scan");
    expect(scan.find((e) => e.tool === "cross_domain")?.args).toMatchObject({ domains: ["podcast", "brand"] });
    const ages = scan.find((e) => e.tool === "share_of_taste");
    expect(ages?.args).toMatchObject({ type: "brand", ages: ["24_and_younger", "35_to_44", "55_and_older"] });
    const set = (ages?.args as { set: string[] } | undefined)?.set ?? [];
    expect(set[0]).toBe("R1");
    expect(set.length).toBeGreaterThan(1);
    expect(digestsIn(fake.streamRequests[1]!, "SHARE")).toHaveLength(1);
    expect(userTextsOf(fake.streamRequests[1]!).filter((t) => t.includes("SCAN NOTE: share_of_taste"))).toEqual([]);
  });

  it("market_selection: a secondary-market question gets its grid in secondary markets, and a pivot on what the grid found", async () => {
    const question = "Comedian Vega wants eight secondary-market dates. Where does the audience out-index other comedians?";
    const intent = intentFor({
      job: "market_selection",
      pillar: "marketing",
      mentions: [{ text: "Comedian Vega", entity_type: "person", role: "primary", public_figure: true }],
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: ["eight secondary-market dates"] },
      mnemonic: "COMEDIAN VEGA <PERSON> MKTS",
    });
    const secondary: MarketId[] = ["louisville", "kansas_city", "indianapolis", "columbus", "charlotte", "richmond", "birmingham", "knoxville"];
    const { events, fake } = await runJob({
      question,
      intent,
      pinned: [...PINNED, ...secondary, "memphis", "tulsa"],
      stream: [
        respond([
          planCall(plan(question, [{ id: "S1", tool: "resolve_entities", purpose: "Resolve the comedians the prior compares." }], "share_of_taste")),
          toolUse("toolu_res", "resolve_entities", {
            mentions: [
              { text: "Comedian Rhea", type: "person", metro: null },
              { text: "Comedian Orion", type: "person", metro: null },
            ],
            ...step("S1"),
          }),
        ]),
        (req) => {
          const set = (digestsIn(req, "SHARE")[0]?.top_rows ?? []).flatMap((r) => (r.ref !== null && r.ref.startsWith("R") ? [r.ref] : []));
          return respond([
            toolUse("toolu_pivot", "share_of_taste", {
              type: "person",
              set: [...new Set(set)].slice(0, 8),
              ages: [],
              audiences: [],
              metros: ["memphis", "tulsa", "boise"],
              ...pivotOn(findingOf(req, ["METRO_OUTLIER", "DROPPED_CANDIDATES"])),
            }),
          ]);
        },
        reportTurn("Comedian Vega", [
          ASK("A Nashville block", "Which East Nashville block fits a Comedian Vega pop-up show?"),
          ASK("Sponsors for the run", "Which brands should sponsor Comedian Vega's tour?"),
        ]),
      ],
    });
    // The grid reads the secondary markets the notes ask for, one per state first, not the majors listed first.
    const grid = ofType(events, "tool.start").find((e) => e.tool === "share_of_taste" && e.phase === "scan");
    expect(grid?.args).toMatchObject({ type: "person", metros: secondary });
    // MARKETS tells the model which tier each market is.
    const marketsLine = userTextsOf(fake.streamRequests[0]!)[0]?.split("\n").find((line) => line.startsWith("MARKETS: ")) ?? "";
    expect(marketsLine).toMatch(/^MARKETS: major: nashville \(Nashville, TN\), .*; secondary: louisville \(Louisville, KY\), /);
  });
});

import { describe, expect, it, vi } from "vitest";
import { reduceRunEvents, type Report, type RunState } from "@ct/contracts";
import {
  buildBriefModel,
  CONVICTION_BAND_LABEL,
  convictionRuleLabel,
  countWord,
  DESK_LABEL,
  figureLegend,
  figureNoteText,
  inlineText,
  JOB_HEAD_LABEL,
  JOB_LABEL,
  SECTION_LABEL,
  SHORT_NOTE_MAX,
  SHORT_TRACE_MAX,
  shortRequestId,
  shortRequestTrace,
  SIGNAL_LABEL,
  STRENGTH_LABEL,
  type BriefModel,
  type Inline,
  type RequestRef,
} from "../../lib/brief";
import { askHref } from "../../components/ask/ask-href";
import { requestTrace as requestTraceOf } from "../../lib/brief/ledger";
import {
  FAKE_QUESTION,
  FAKE_RUN,
  FAKE_STARTED_AT,
  FIXTURE_RUN,
  fakeRunState,
  fixtureReport,
  fixtureRunEvents,
  plainProse,
  proseBlocks,
  readingOrder,
  untracedDigits,
} from "./support";

vi.mock("server-only", () => ({}));

const NOW = FAKE_STARTED_AT + 10 * 60_000;
const fakeState: RunState = fakeRunState();
const fake = (): BriefModel => buildBriefModel(fakeState, NOW);

function reportOf(state: RunState): Report {
  if (!state.report) throw new Error("the run has no report");
  return state.report;
}
const fakeReport = reportOf(fakeState);

/** A fixture report that cites the stale and the UNAVAILABLE metric too. */
const citingReport: Report = {
  ...fixtureReport,
  verdict: { ...fixtureReport.verdict, thesis: "Its audience sits apart {{M1}} [E1]; momentum is {{M3}} and rose {{M2}} over {{WINDOW}}." },
  kpis: [...fixtureReport.kpis, { metricId: "M3", label: "Momentum", comparator: null }],
  arguments: [
    ...fixtureReport.arguments,
    {
      id: "A2",
      section: "risk",
      qlooFact: "Marlowe Ridge is {{M3}} [E1].",
      ourRead: "A gap in coverage.",
      metricIds: ["M3"],
      evidenceIds: ["E1"],
      strength: "THIN",
    },
  ],
  bearCase: [{ text: "Momentum stays {{M3}} after the window.", metricIds: ["M3"] }],
};

const fixtureState = (report: Report = fixtureReport) => reduceRunEvents(FIXTURE_RUN, fixtureRunEvents(report));
const fixtureModel = (report: Report = fixtureReport) => buildBriefModel(fixtureState(report), NOW);
const thesisOf = (thesis: string) => fixtureModel({ ...fixtureReport, verdict: { ...fixtureReport.verdict, thesis } }).answer.thesis ?? [];
const shape = (inlines: readonly Inline[]) => inlines.map((p) => (p.kind === "text" ? p.text : `<${p.kind}>`));

function pieces(model: BriefModel): Inline[] {
  return proseBlocks(model).flatMap((b) => b.inlines);
}

describe("buildBriefModel: a finished brief", () => {
  it("leads with the answer: head, signal, conviction and the answer prose", () => {
    const model = fake();
    const { score, band } = fakeReport.verdict.confidence;
    expect(model.mode).toBe("final");
    expect(model.header).toMatchObject({
      deskLabel: "Investment",
      jobLabel: "Competitors",
      question: FAKE_QUESTION,
      signal: { signal: fakeReport.verdict.signal, label: SIGNAL_LABEL[fakeReport.verdict.signal] },
      // The running head names the finding; the answer's kicker below stays the signal.
      finding: fakeReport.verdict.tag,
      conviction: { score, band, bandLabel: CONVICTION_BAND_LABEL[band], text: `${CONVICTION_BAND_LABEL[band]} · ${score}`, position: score / 100 },
      briefLabel: `Brief ${FAKE_RUN.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      date: "14 Oct 2026",
      figureCount: model.evidence.figures.length,
      investmentBanner: true,
      incomplete: false,
    });
    expect(model.evidence.figures.length).toBeGreaterThan(0);
    expect(model.header.footer).toBe(`${model.header.readMinutes} min read · ${model.evidence.figures.length} figures · ${model.header.sourceCount} sources`);
    expect(model.answer).toMatchObject({ state: "final", tag: SIGNAL_LABEL[fakeReport.verdict.signal] });
    expect(inlineText(model.answer.headline)).toBe(plainProse(fakeReport.verdict.headline, fakeState));
    expect(inlineText(model.answer.thesis)).toBe(plainProse(fakeReport.verdict.thesis, fakeState));
    expect(model.answer.thesis?.some((p) => p.kind === "metric")).toBe(true);
  });

  it("names the finding by the verdict tag, else by the signal label", () => {
    expect(fakeReport.verdict.tag).toBe("Taste island");
    // undefined: a note stored before the tag existed.
    const labelled = (tag: string | null | undefined) => fixtureModel({ ...fixtureReport, verdict: { ...fixtureReport.verdict, tag } });
    expect(labelled("Clear lead").header.finding).toBe("Clear lead");
    for (const tag of [undefined, null, "", "Ranks 3rd of 8 brands"]) {
      const model = labelled(tag);
      expect(model.header.finding, String(tag)).toBe(SIGNAL_LABEL[fixtureReport.verdict.signal]);
      expect(model.answer.tag).toBe(SIGNAL_LABEL[fixtureReport.verdict.signal]);
    }
    expect(buildBriefModel(reduceRunEvents(FIXTURE_RUN, []), NOW).header.finding).toBeNull();
  });

  it("names the job in the reader's words, terser in the running head", () => {
    const model = fake();
    expect(model.header.jobLabel).toBe(JOB_HEAD_LABEL.brand_health);
    expect(model.method.interpretation?.jobLabel).toBe("Real competitors");
    expect(JOB_LABEL.brand_health).toBe("Real competitors");
    expect(JOB_HEAD_LABEL.head_to_head).toBe(JOB_LABEL.head_to_head);
  });

  it("gives every number in the prose a footnote that resolves to its metric and requests", () => {
    for (const [state, model] of [
      [fakeState, fake()],
      [fixtureState(citingReport), fixtureModel(citingReport)],
    ] as const) {
      const byN = new Map(model.footnotes.map((f) => [f.n, f]));
      const blocks = proseBlocks(model);
      expect(blocks.length).toBeGreaterThan(0);
      for (const { where, inlines } of blocks) {
        // No raw token survives, and no plain text prints a number: numbers are metric pieces.
        expect(inlineText(inlines), where).not.toMatch(/\{\{|\[E\d/);
        for (const piece of inlines) {
          if (piece.kind === "text") expect(untracedDigits(piece.text, state), `${where}: "${piece.text}"`).toEqual([]);
          if (piece.kind === "metric") {
            const note = byN.get(piece.footnote);
            expect(note, `${where} ${piece.metric.id}`).toBeDefined();
            expect(note).toMatchObject({ kind: "metric", key: piece.metric.id });
          }
          if (piece.kind === "cite") expect(byN.get(piece.footnote)).toMatchObject({ kind: "evidence", key: piece.evidenceId });
          expect(piece.kind).not.toBe("missing");
        }
      }
      for (const k of model.evidence.keyFigures.filter((k) => k.state === "ready")) {
        expect(byN.get(k.footnote ?? -1)).toMatchObject({ kind: "metric", key: k.metric?.id });
      }
      for (const c of model.risks.changes) if (c.now) expect(byN.get(c.now.footnote)).toMatchObject({ key: c.now.metric.id });
      // Every measured footnote points at the request behind it.
      for (const note of model.footnotes.filter((f) => f.kind === "metric" && !f.unavailable)) {
        expect(note.requests.length, note.key).toBeGreaterThan(0);
        expect(note.trace).toMatch(/req |computed in code/);
      }
    }
    // The digit check bites: a number typed into the prose is caught, an entity or age bucket name is not.
    expect(untracedDigits("rose 12% in 4 of 5 rows", fakeState)).toEqual(["12%", "4", "5"]);
    expect(untracedDigits("the ≤24 bucket", fakeState)).toEqual([]);
  });

  it("numbers footnotes in reading order: answer, priors, key figures, figures, arguments, risks", () => {
    for (const model of [fake(), fixtureModel(), fixtureModel(citingReport)]) {
      const order = readingOrder(model);
      expect(order).toEqual(order.map((_, i) => i + 1));
      expect(model.footnotes.map((f) => f.n)).toEqual(order);
    }
    const model = fake();
    const sections = model.footnotes.map((f) => f.firstCitedIn);
    const rank = ["answer", "conviction", "priors", "key_figures", "figures", "arguments", "risks"];
    expect(sections.map((s) => rank.indexOf(s))).toEqual([...sections.map((s) => rank.indexOf(s))].sort((a, b) => a - b));
    expect(sections[0]).toBe("answer");
  });

  it("never renders an UNAVAILABLE metric as 0", () => {
    const model = fixtureModel(citingReport);
    const unavailable = pieces(model).filter((p): p is Extract<Inline, { kind: "metric" }> => p.kind === "metric" && p.metric.unavailable);
    expect(unavailable.length).toBeGreaterThanOrEqual(3);
    for (const p of unavailable) {
      expect(p.metric.text).toBe("not measured");
      expect(p.metric.reasonLabel).toBe("Qloo has no data of this kind for this type");
      expect(p.metric.direction).toBeNull();
    }
    const kpi = model.evidence.keyFigures.find((k) => k.key === "M3");
    expect(kpi?.metric?.text).toBe("not measured");
    expect(model.risks.changes[0]?.now?.metric.text).toBe("not measured");
    const note = model.footnotes.find((f) => f.key === "M3");
    expect(note?.unavailable).toEqual({ reason: "unavailable", label: "Qloo has no data of this kind for this type" });
    expect(note?.text).toMatch(/not measured/);
    // Nowhere does the brief print a 0 for it.
    expect(inlineText(model.answer.thesis)).toBe("Its audience sits apart 0.42; momentum is not measured and rose Rising over Apr–Sep 2025.");
  });

  it("sets each citation on the word before it, and folds an [E#] that follows its own metric", () => {
    const thesis = fixtureModel().answer.thesis ?? [];
    expect(thesis.map((p) => p.kind)).toEqual(["text", "metric", "text"]);
    expect(inlineText(thesis, { footnotes: true })).toBe("Its audience sits apart from its category 0.42[1].");
    // An [E#] that is not the metric's own evidence stays a citation, attached to what precedes it.
    expect(shape(thesisOf("Apart {{M1}} [E2]."))).toEqual(["Apart ", "<metric>", "<cite>", "."]);
    expect(shape(thesisOf("Last in its rows [E2]."))).toEqual(["Last in its rows", "<cite>", "."]);
    expect(shape(thesisOf("Two sources agree [E1] [E2]."))).toEqual(["Two sources agree", "<cite>", "<cite>", "."]);
    expect(shape(thesisOf("[E2] opens the line."))).toEqual(["<cite>", " opens the line."]);
    // The fake run's prose reads the same way: no text piece ends in a space before a citation.
    for (const { where, inlines } of proseBlocks(fake())) {
      inlines.forEach((p, i) => {
        if (inlines[i + 1]?.kind === "cite" && p.kind === "text") expect(p.text, where).not.toMatch(/\s$/);
      });
    }
  });

  it("resolves a measured footnote to the request behind it", () => {
    const model = fake();
    const note = model.footnotes.find((f) => f.kind === "metric" && f.metric?.badge === "MEASURED" && f.firstCitedIn === "answer");
    if (!note?.metric) throw new Error("the fake run cites no measured metric in its answer");
    const metric = fakeState.metrics[note.metric.id];
    const calls = (metric?.evidenceIds ?? []).flatMap((id) => fakeState.evidence[id]?.qlooCallIds ?? []);
    expect(note).toMatchObject({ computed: null, unavailable: null, evidenceIds: metric?.evidenceIds });
    expect(note.requests.map((r) => r.qlooCallId)).toEqual([...new Set(calls)]);
    expect(note.requests[0]).toMatchObject({ endpoint: "/v2/insights", filterLabel: "brand" });
    expect(note.requests[0]?.shortRequestId).toMatch(/^.{4}….{4}$/);
    expect(note.text).toMatch(/^Qloo \/v2\/insights · brand ← R1 Juniper Cola.* · \d+ rows\. .+\.$/);
    expect(note.text).toContain(note.metric.label);
    expect(note.trace).toMatch(new RegExp(`^${note.requests.length} requests · req .{4}….{4} · (live|cached|partly cached|reused)`));
    // Clicking the number opens the request: each request links to a source that lists this footnote.
    for (const r of note.requests) {
      expect(r.sourceIndex).not.toBeNull();
      expect(model.sources.items[r.sourceIndex ?? -1]?.footnotes).toContain(note.n);
    }
  });

  it("resolves a DERIVED metric to code, with its formula id", () => {
    const distinct = Object.values(fakeState.metrics).find((m) => m?.formulaId === "subs.distinctiveness");
    const note = fake().footnotes.find((f) => f.key === distinct?.id);
    expect(distinct).toMatchObject({ badge: "DERIVED", formulaId: "subs.distinctiveness" });
    expect(note?.computed).toEqual({ formulaId: "subs.distinctiveness", label: "computed in code · QUANT" });
    expect(note?.trace).toBe("computed in code · QUANT · subs.distinctiveness");
    expect(note?.text).toMatch(/computed in QUANT from \d+ requests\.$/);
  });

  it("scores the priors against the data", () => {
    const { priors } = fake();
    const rows = fakeReport.scorecard;
    expect(rows.length).toBeGreaterThan(1);
    expect(priors.kicker).toMatch(new RegExp(`^${countWord(rows.length)} priors, written before any data · \\d\\d:\\d\\d:\\d\\d$`));
    expect(priors.items.map((p) => [p.id, p.word, p.progress])).toEqual(rows.map((r) => [r.hypothesisId, r.verdict, null]));
    const marks = { REFUTED: "×", CONFIRMED: "✓", INCONCLUSIVE: "–" } as const;
    priors.items.forEach((p, i) => {
      const row = rows[i];
      if (!row) throw new Error("row missing");
      expect(p.mark).toBe(marks[row.verdict]);
      expect(p.expected).toBe(`We expected: ${row.statement}`);
      expect(inlineText(p.measured)).toBe(`Measured: ${plainProse(row.note, fakeState)}`);
    });
    const counts = (["REFUTED", "CONFIRMED", "INCONCLUSIVE"] as const).map((v) => [v, rows.filter((r) => r.verdict === v).length] as const);
    expect(priors.tally).toBe(counts.filter(([, n]) => n > 0).map(([v, n]) => `${n} ${v.toLowerCase()}`).join(" · "));
  });

  it("computes conviction in code and explains it", () => {
    const { conviction } = fake();
    const { score, breakdown } = fakeReport.verdict.confidence;
    expect(conviction.state).toBe("final");
    expect(conviction.aside).toBe("Computed, not chosen");
    expect(conviction.why?.label).toBe(`Why ${score}`);
    expect(conviction.why?.lines.map((l) => [l.rule, l.points])).toEqual(breakdown.map((b) => [b.rule, b.points]));
    // The test run's scan runs every scan skill, so no CODE FALLBACK penalty applies.
    expect(conviction.why?.lines.map((l) => l.rule)).not.toContain("code_fallback");
    for (const line of conviction.why?.lines ?? []) expect(line.label).toBe(convictionRuleLabel(line.rule, line.count));
    expect(conviction.why?.total.text).toBe(`= ${score}`);
    expect(conviction.why?.total.label).toMatch(/^Starts at 100; (one penalty applies|\w+ penalties apply)$/);
    expect(conviction.coverage?.text).toMatch(/^\d+ of \d+ evidence bundles ok$/);
    expect(conviction.scale.map((s) => s.label)).toEqual(["LOW", "MEDIUM", "HIGH"]);
  });

  it("builds key figures, figures with legends and source lines, and arguments", () => {
    const { evidence } = fake();
    expect(evidence.keyFigures.map((k) => [k.key, k.state])).toEqual(fakeReport.kpis.map((k) => [k.metricId, "ready"]));
    for (const k of evidence.keyFigures) {
      const metric = fakeState.metrics[k.key as keyof RunState["metrics"]];
      expect(k.metric?.text).toBe(metric?.display);
      // The long label goes to the inspector with the metric; the strip prints a short one.
      expect(k.metric?.label).toBe(metric?.label);
    }
    const exhibits = fakeReport.exhibits.filter((e) => e.kind !== "Scorecard");
    expect(evidence.figures.map((f) => [f.number, f.datasetId, f.title, f.needsFetch])).toEqual(exhibits.map((e, i) => [i + 1, e.datasetId, e.title, false]));
    // The first Substitution Map (a Taste Position card may open the figures).
    const map = evidence.figures.find((f) => f.dataset?.kind === "Matrix");
    if (map?.dataset?.kind !== "Matrix") throw new Error("the brief has no matrix");
    expect(map.viz).toBe("MatrixGrid");
    // Short codes: one per column, unique, two or three letters, initials for a two-word name.
    const codes = map.legend.codes;
    expect(codes.map((c) => c.label)).toEqual(map.dataset.payload.cols.map((c) => c.label));
    expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);
    for (const c of codes) expect(c.code).toMatch(/^[A-Z0-9]{2,3}$/);
    expect(codes.find((c) => c.label === "Juniper Cola")?.code).toBe("JC");
    expect(map.legend.ramp?.label).toBe(map.dataset.payload.valueLabel);
    expect(map.source).toMatchObject({ text: `Source: Qloo /v2/insights · ${map.source.requestCount} requests · computed in code`, computedInCode: true });
    expect(map.source.requestCount).toBeGreaterThan(1);
    expect(map.methodHref).toBe(`/method#${map.dataset.formulaIds[0]}`);
    expect(map.methodHref).toBe("/method#subs.similarity");
    expect(evidence.aside).toMatch(new RegExp(`^${evidence.figures.length} figures · \\d+ (of \\d+ )?requests$`));
    expect(evidence.arguments.map((a) => [a.id, a.sectionLabel, a.strengthLabel])).toEqual(
      fakeReport.arguments.map((a) => [a.id, SECTION_LABEL[a.section], STRENGTH_LABEL[a.strength]]),
    );
  });

  it("labels key figures short, with who or what each is measured against underneath", () => {
    // The report's KPI labels are the metrics' own long labels, so the job's slot labels stand in.
    expect(fakeReport.kpis.every((k) => k.label.length > 24)).toBe(true);
    expect(fake().evidence.keyFigures.map((k) => [k.label, k.comparator])).toEqual([
      ["Nearest audience", "with Granite Outfitters"],
      ["Distinctiveness", "vs peers"],
      // The next-gen slot holds a youth index here, which keeps its own name.
      ["Youth index", "0 = average"],
    ]);
    // A short report label is kept; a historical figure names its window.
    expect(fixtureModel(citingReport).evidence.keyFigures.map((k) => [k.key, k.label, k.comparator])).toEqual([
      ["M1", "Distinctiveness", "vs peers"],
      ["M3", "Momentum", null],
    ]);
    const stale = fixtureModel({ ...fixtureReport, kpis: [{ metricId: "M2", label: "momentum of Aurora Footwear over the trending window", comparator: null }] });
    expect(stale.evidence.keyFigures[0]).toMatchObject({ label: "Momentum of Aurora Footwear", comparator: "Apr–Sep 2025 only" });
  });

  it("gives every footnote a short form for the margin and keeps the long form for the inspector", () => {
    for (const model of [fake(), fixtureModel(citingReport)]) {
      for (const f of model.footnotes) {
        // Two short lines: a note that fits two lines (a figure's codes excepted) and a whole one-line trace.
        if (f.kind !== "figure") expect(f.short.text.length, `${f.n} ${f.short.text}`).toBeLessThanOrEqual(SHORT_NOTE_MAX);
        expect(f.short.trace.length, f.short.trace).toBeLessThanOrEqual(SHORT_TRACE_MAX);
        expect(f.short.trace).toMatch(/^(req \S+( · .+)?|\d+ requests · req \S+|computed in code · QUANT|no request)$/);
        expect(f.short.text).toMatch(/^[A-Z]/);
        // The short form names refs bare; the long one keeps the names, the purpose and the formula id.
        expect(f.short.text).not.toMatch(/← R\d+ [A-Z][a-z]/);
        expect(f.text.length).toBeGreaterThanOrEqual(f.short.text.length);
        if (f.computed) {
          expect(f.short.trace).toBe("computed in code · QUANT");
          expect(f.trace).toBe(`computed in code · QUANT · ${f.computed.formulaId}`);
        }
      }
    }
    const notes = fake().footnotes;
    const byFormula = (formulaId: string) => notes.find((f) => f.kind === "metric" && f.metric?.formulaId === formulaId);
    // A measured number: its requests, bare refs and rows, then its short label.
    const overlap = byFormula("subs.similarity");
    expect(overlap?.short.text).toMatch(/^Qloo \/v2\/insights · brand ← R1, R6 · \d+ rows\. Audience overlap\.$/);
    expect(overlap?.short.trace).toMatch(/^\d+ requests · req .{4}….{4}$/);
    expect(overlap?.text).toContain("R1 Juniper Cola");
    // A derived number: its short label and QUANT.
    const distinct = byFormula("subs.distinctiveness");
    expect(distinct?.short).toEqual({ text: `Distinctiveness vs peers, from ${distinct?.requests.length} Qloo requests.`, trace: "computed in code · QUANT" });
    // An evidence bundle keeps its purpose when it fits, else names its skill; the long note keeps both.
    const bundle = notes.find((f) => f.kind === "evidence");
    expect(bundle?.short.text).toMatch(/^Qloo \/v2\/insights · brand ← R1 · \d+ rows\. Substitution map\.$/);
    expect(bundle?.text).toContain(fakeState.evidence[bundle?.key as keyof RunState["evidence"]]?.summary.split(";")[0] ?? "missing");
    // A matrix figure: its short codes.
    const matrixId = fake().evidence.figures.find((f) => f.kind === "Matrix")?.datasetId;
    const figure = notes.find((f) => f.kind === "figure" && f.key === matrixId);
    expect(figure).toBeDefined();
    expect(figure?.short.text).toBe(figure?.text);
    // A number not measured says so with its short label; a historical one keeps its window.
    const fixtureNotes = new Map(fixtureModel(citingReport).footnotes.map((f) => [f.key, f]));
    expect(fixtureNotes.get("M3")?.short.text).toBe("Momentum of Marlowe Ridge: not measured.");
    expect(fixtureNotes.get("M2")?.short.text).toBe("Qloo /v2/insights · brand ← R2 · 30 rows. Apr–Sep 2025 only.");
  });

  it("traces one request with its cache state, and several by count, never past one margin line", () => {
    const ref = (requestId: string | null, cacheLabel: string): RequestRef => ({
      qlooCallId: `qc-${requestId}`,
      sourceIndex: null,
      requestId,
      shortRequestId: shortRequestId(requestId),
      endpoint: "/v2/insights",
      filterType: "urn:entity:brand",
      filterLabel: "brand",
      params: [],
      rows: 15,
      ms: 120,
      cache: null,
      cacheLabel,
    });
    const a = ref("abcd-invented-9f2a", "cached 1h");
    const b = ref("efgh-invented-41c0", "live 22 Oct, 14:30");
    expect(shortRequestTrace([a])).toBe("req abcd…9f2a · cached 1h");
    expect(shortRequestTrace([b])).toBe("req efgh…41c0 · live 22 Oct, 14:30");
    expect(shortRequestTrace([a, b])).toBe("2 requests · req abcd…9f2a");
    expect(shortRequestTrace([])).toBe("no request");
    expect(shortRequestTrace([ref(null, "")])).toBe("req no response");
    // A cache label that would run past one line is left to the inspector.
    expect(shortRequestTrace([ref("ijkl-invented-77aa", "reused from an earlier brief of this run")])).toBe("req ijkl…77aa");
    // The long trace keeps the cache state of several.
    expect(requestTraceOf([a, b])).toBe("2 requests · req abcd…9f2a · cached 1h");
  });

  it("asks for a dataset the stream did not carry inline, and rebuilds its legend and note once fetched", () => {
    // The first matrix: the opening scan's Substitution Map.
    const id = fake().evidence.figures.find((f) => f.kind === "Matrix")?.datasetId as keyof RunState["datasets"];
    const map = fakeState.datasets[id];
    if (!map?.data) throw new Error(`the fake run streams ${id} inline`);
    const inline = fake().evidence.figures.find((f) => f.datasetId === id);
    const large = buildBriefModel({ ...fakeState, datasets: { ...fakeState.datasets, [id]: { ...map, data: null } } }, NOW);
    const figure = large.evidence.figures.find((f) => f.datasetId === id);
    expect(figure).toMatchObject({ needsFetch: true, dataset: null, kind: "Matrix", methodHref: "/method", legend: { series: [], ramp: null, codes: [] } });
    expect(figure?.datasetUrl).toBe(`/api/runs/${FAKE_RUN}/datasets/${id}`);
    const note = large.footnotes.find((f) => f.key === id);
    expect(note?.text).toMatch(/computed in code\.$/);
    // What the page does with the fetched dataset gives the same legend and note as an inline one.
    expect(figureLegend(map.data)).toEqual(inline?.legend);
    expect(figureNoteText(figureLegend(map.data), note?.text ?? "")).toBe(fake().footnotes.find((f) => f.key === id)?.text);
  });

  it("lists risks as change rows with what the number is now, and the limitations", () => {
    const { risks } = fake();
    expect(risks.changes).toHaveLength(fakeReport.bearCase.length);
    risks.changes.forEach((c, i) => {
      const bear = fakeReport.bearCase[i];
      expect(inlineText(c.condition)).toBe(plainProse(bear?.text ?? "", fakeState));
      const id = bear?.metricIds[0];
      expect(c.now?.metric.text ?? null).toBe(id ? (fakeState.metrics[id]?.display ?? null) : null);
      expect(c.trigger).toBeNull();
    });
    expect(risks.limitations.map((l) => l.text)).toEqual(fakeReport.limitations.map((l) => l.text));
    expect(risks.limitations.map((l) => l.flagLabel)).toContain("Not scored");
  });

  it("explains the method: steps joined with their calls, pivots, fallbacks, CLERK and the CHECKER", () => {
    const { method } = fixtureModel();
    expect(method.steps.map((s) => [s.origin, s.stepId, s.tool, s.estimate, s.actual, s.status])).toEqual([
      ["plan", "S1", "peer_landscape", 7, 3, "ok"],
      ["plan", "S2", "share_of_taste", 3, 0, "not_run"],
      ["followup", null, "cross_domain", 1, 1, "partial"],
    ]);
    expect(method.steps[2]).toMatchObject({ pivot: true, triggerFindingId: "F1" });
    expect(method.steps[2]?.purpose).toMatch(/^Follow-up on F1: /);
    expect(method.line).toBe("3 steps · 4 requests, 3 cached · computed in code, then traced");
    expect(method.pivots.map((p) => p.line)).toEqual([expect.stringMatching(/^ANALYST PIVOT · F1 → Cultural neighbourhood: .+/)]);
    expect(method.fallbacks.map((f) => f.line)).toEqual(["CODE FALLBACK · POLYGON → POINT: polygon returned no tags"]);
    expect(method.interpretation).toMatchObject({
      deskLabel: "Investment",
      jobLabel: "Real competitors",
      detail: "Investment lens · 1 of 2 names matched exactly",
    });
    expect(method.checker).toMatchObject({ state: "passed", line: "3/3 numbers traced · 0 advice terms" });

    // The test run: the opening scan first, then the plan in its order, then the follow-ups.
    const steps = fake().method.steps;
    expect(steps[0]).toMatchObject({ origin: "scan", tool: "peer_landscape", status: "ok" });
    const origins = steps.map((s) => s.origin);
    expect(origins).toEqual([...origins].sort((a, b) => ["scan", "plan", "followup"].indexOf(a) - ["scan", "plan", "followup"].indexOf(b)));
    expect(steps.filter((s) => s.origin === "plan").map((s) => s.stepId)).toEqual(fakeState.plan?.plan.steps.map((s) => s.id));
    // A finished run never leaves a step "planned" or "running".
    for (const s of steps) expect(["planned", "running"]).not.toContain(s.status);
    // Its scan runs every scan skill of the job, so nothing fell back.
    expect(fake().method.fallbacks).toEqual([]);
  });

  it("lists every Qloo request as a source, with cache status and the evidence that used it", () => {
    const model = fake();
    const chips = fakeState.qloo.chips;
    expect(model.sources.items).toHaveLength(chips.length);
    expect(model.sources.items.map((s) => s.n)).toEqual(chips.map((_, i) => i + 1));
    const insight = model.sources.items.find((s) => s.endpoint === "/v2/insights");
    expect(insight).toMatchObject({ filterLabel: "brand", refs: expect.arrayContaining(["R1 Juniper Cola"]) });
    expect(insight?.evidenceIds.length).toBeGreaterThan(0);
    const live = model.sources.items.find((s) => s.cache === "miss");
    expect(live?.cacheLabel).toMatch(/^live 14 Oct, 09:1\d$/);
    const reused = model.sources.items.find((s) => s.cache === "reused");
    expect(reused?.cacheLabel).toMatch(/^reused from #[0-9A-Z]{4}$/);
    const cached = fakeState.qloo.cached + fakeState.qloo.reused;
    const endpoints = new Set(chips.map((c) => c.endpoint)).size;
    expect(model.sources.line).toBe(`${chips.length} requests · ${cached} cached · ${endpoints} endpoints`);
  });

  it("closes with next moves, disclaimers and the status line", () => {
    const model = fake();
    const chips = fakeState.qloo.chips.length;
    const cached = fakeState.qloo.cached + fakeState.qloo.reused;
    // Each next move is a chip with the desk it reads as, opening Ask with this brief as the parent.
    expect(model.nextMoves.map((m) => [m.label, m.question])).toEqual(fakeReport.nextMoves.map((m) => [m.label, m.question]));
    for (const m of model.nextMoves) {
      expect(m.href).toBe(askHref(m.question, FAKE_RUN));
      expect(m.deskLabel).toBe(DESK_LABEL[m.pillar]);
    }
    expect(model.disclaimers).toEqual(fakeReport.disclaimers);
    expect(model.statusLine).toEqual({
      honesty: "Analytics, not financial advice · Group-level taste data · No individuals · Snapshot 14 Oct 2026",
      snapshot: "14 Oct 2026",
      window: null,
      requests: `Qloo ${chips} req · ${cached} cached`,
    });
    expect(fixtureModel().statusLine.window).toBe("Trend window Apr–Sep 2025");
    const { traced, total } = fakeReport.receipt.numbersTraced;
    expect(model.trace).toMatchObject({ state: "passed", headline: `${traced}/${total} numbers traced` });
    expect(model.trace.detail).toMatch(/^Checker · 0 advice terms · 14 Oct 2026, 09:1\d$/);
    expect(model.method.checker).toMatchObject({ state: "passed", line: `${traced}/${total} numbers traced · 0 advice terms` });
    expect(model.live).toBeNull();
    expect(model.terminal).toBeNull();
    expect(model.outline.map((o) => [o.number, o.label, o.available])).toEqual([
      ["01", "Answer", true],
      ["02", "Conviction", true],
      ["03", "Evidence", true],
      ["04", "Risks", true],
      ["05", "Method", true],
      ["06", "Sources", true],
    ]);
  });

  it("is pure: the same state gives the same model", () => {
    expect(buildBriefModel(fakeState, NOW)).toEqual(buildBriefModel(fakeState, NOW));
    expect(JSON.parse(JSON.stringify(buildBriefModel(fakeState, NOW)))).toEqual(buildBriefModel(fakeState, NOW));
  });
});

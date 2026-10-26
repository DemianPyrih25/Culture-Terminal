import { FIXED_DISCLAIMERS, isVerdictTag, VIZ_COMPAT, type Metric, type Report, type RunState } from "@ct/contracts";
import { figureLegend, figureSource, methodHrefFor } from "./figures";
import { FootnoteRegistry, inlineText } from "./footnotes";
import {
  capitalize,
  CONVICTION_BAND_LABEL,
  convictionRuleLabel,
  countWord,
  DESK_LABEL,
  flagLabel,
  formatTrendWindow,
  formatUtcDate,
  formatUtcTime,
  JOB_HEAD_LABEL,
  MATCH_LABEL,
  plural,
  PRIORITY_LABEL,
  SAFETY_LABEL,
  SECTION_LABEL,
  SIGNAL_LABEL,
  STRENGTH_LABEL,
  TOOL_DATA_LABEL,
} from "./format";
import { keyFigureText } from "./key-figures";
import { KPI_SLOTS, pickMatches, skillForFormula } from "./kpi-slots";
import { arrivedAt, buildLedger, firstTs, metricView, requestsForEvidence, type Ledger } from "./ledger";
import { buildLive, stoppedEarly, traceNote } from "./live";
import { areaReads, buildLocation, datasetPlace, type AreaRead } from "./location";
import { buildMethod, buildSources } from "./method";
import { buildNextMoves } from "./next-moves";
import type {
  BriefAnswer,
  BriefArgument,
  BriefConviction,
  BriefEvidence,
  BriefFigure,
  BriefHeader,
  BriefKeyFigure,
  BriefModel,
  BriefPrior,
  BriefPriors,
  BriefRisks,
  BriefStatusLine,
  BriefTerminal,
  ConvictionSummary,
  Inline,
  OutlineEntry,
  PriorState,
  SignalTag,
} from "./types";

/**
 * buildBriefModel: a RunState in, the whole brief out (Concept A, D36). Pure: the same state and
 * `now` give the same model, so live streams, replays and server-rendered notes print alike.
 *
 * Footnotes: a finished brief cites in reading order (answer, conviction, priors, key figures,
 * figures, arguments, risks), so its numbers read 1, 2, 3 down the page. A live brief numbers what
 * it shows in arrival order instead, and renumbers once when report.final arrives.
 */

const SCALE: BriefConviction["scale"] = [
  { band: "LOW", label: "LOW", from: 0, to: 0.5 },
  { band: "MED", label: "MEDIUM", from: 0.5, to: 0.75 },
  { band: "HIGH", label: "HIGH", from: 0.75, to: 1 },
];
const TICKS = [0, 0.5, 0.75, 1];

/** "A1F3": the first four letters and digits of the run id. */
export function briefIdOf(runId: string): string {
  return runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "NEW";
}

function signalTag(report: Report | null): SignalTag | null {
  return report ? { signal: report.verdict.signal, label: SIGNAL_LABEL[report.verdict.signal] } : null;
}

/**
 * The finding in a few words: the report's verdict tag ("Taste island"), else its signal label, for
 * notes stored before the tag existed and notes without one (an evidence digest, a forced signal).
 */
export function findingOf(report: Report | null): string | null {
  if (!report) return null;
  const tag = report.verdict.tag?.trim();
  return isVerdictTag(tag) ? tag : SIGNAL_LABEL[report.verdict.signal];
}

function convictionSummary(report: Report | null): ConvictionSummary | null {
  if (!report) return null;
  const { score, band } = report.verdict.confidence;
  return { score, band, bandLabel: CONVICTION_BAND_LABEL[band], text: `${CONVICTION_BAND_LABEL[band]} · ${score}`, position: Math.min(1, Math.max(0, score / 100)) };
}

// Key figures -----------------------------------------------------------------------------------------

/**
 * One entry of the live strip: a metric that has arrived, which its key's spec names as the finished
 * brief will (a pending "Area lift" becomes "East Cesar Chavez"), or a slot still pending under its label.
 */
type LiveKeyFigure = { metric: Metric } | { metric: null; label: string; pendingNote: string };

/** What a pending key figure says once the run has stopped: it will not arrive, and it is not 0. */
const STOPPED_FIGURE_NOTE = "not measured · run stopped";

/** The job's key-figure slots filled with the metrics that have arrived, the rest pending. */
function liveKeyFigures(ledger: Ledger): LiveKeyFigure[] {
  const { state } = ledger;
  const job = state.intent?.job;
  if (!job) return [];
  const stopped = stoppedEarly(state);
  // As the agent picks (packages/agent/src/report/kpis.ts), with nothing cited yet: the subject's own
  // metrics first, then arrival order; a `top` slot by value, highest first.
  const subject = state.resolves.find((r) => r.role === "primary" && r.ref !== null)?.ref ?? null;
  const focus = { subject, peers: state.resolves.flatMap((r) => (r.role === "peer" && r.ref !== null ? [r.ref] : [])) };
  const order = (m: Metric) => (m.subjectRefs[0] === subject ? 0 : 1);
  const metrics = Object.values(state.metrics)
    .filter((m) => m.value !== null)
    .sort((a, b) => order(a) - order(b) || arrivedAt(ledger, "metric", a.id) - arrivedAt(ledger, "metric", b.id));
  const picked = new Set<string>();
  const out: LiveKeyFigure[] = [];
  for (const slot of KPI_SLOTS[job]) {
    let hits: Metric[] = [];
    for (const pick of slot.picks) {
      hits = metrics.filter((m) => !picked.has(m.id) && pickMatches(m, pick, focus));
      if (hits.length > 0) break;
    }
    if (slot.top) hits = [...hits].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const take = hits.slice(0, slot.count);
    for (const m of take) {
      picked.add(m.id);
      out.push({ metric: m });
    }
    const skill = skillForFormula(slot.picks[0]?.key ?? "");
    const calls = skill ? state.toolCalls.filter((t) => t.tool === skill) : [];
    const note = stopped
      ? STOPPED_FIGURE_NOTE
      : calls.some((t) => t.status === "running")
        ? "computing · QUANT"
        : calls.length > 0
          ? "no reading yet"
          : skill
            ? `waiting on ${TOOL_DATA_LABEL[skill]}`
            : "waiting";
    for (let i = take.length; i < slot.count; i++) out.push({ label: slot.label, metric: null, pendingNote: note });
  }
  return out;
}

// Sections ---------------------------------------------------------------------------------------------

/** A run refused by CLERK (before any data) or by the ANALYST (after some). */
const refusedRun = (state: RunState): boolean => state.ended?.status === "refused" || state.intent?.safety.allowed === false;

function buildAnswer(state: RunState, notes: FootnoteRegistry): BriefAnswer {
  const report = state.report;
  if (!report) {
    const unwritten = { signal: null, headline: null, thesis: null };
    const status = stoppedEarly(state) ? "stopped" : "pending";
    // A run that waits for a pick or was refused did not stop short, so it does not say "run stopped".
    if (state.needsInput !== null) return { state: status, tag: "Waiting for your pick", ...unwritten };
    if (refusedRun(state)) return { state: status, tag: "Question refused", ...unwritten };
    return status === "stopped"
      ? { state: "stopped", tag: "Not written · run stopped", ...unwritten }
      : { state: "pending", tag: "Written last, after the check", ...unwritten };
  }
  const signal = signalTag(report);
  return {
    state: "final",
    tag: signal?.label ?? "",
    signal,
    headline: notes.prose(report.verdict.headline, "answer"),
    thesis: notes.prose(report.verdict.thesis, "answer"),
  };
}

function buildConviction(ledger: Ledger): BriefConviction {
  const { state } = ledger;
  const report = state.report;
  const summary = convictionSummary(report);
  if (!report || !summary) {
    const stopped = stoppedEarly(state);
    return {
      state: stopped ? "stopped" : "pending",
      aside: stopped ? "Not computed · run stopped" : "Pending · computed after the check",
      summary: null,
      scale: SCALE,
      ticks: TICKS,
      ruleNote: "Starts at 100 once every number is traced, minus fixed penalties. The model cannot set it.",
      why: null,
      coverage: null,
    };
  }
  const { breakdown } = report.verdict.confidence;
  const penalties = breakdown.length;
  const { evidenceOk, evidenceTotal } = report.verdict.coverage;
  return {
    state: "final",
    aside: "Computed, not chosen",
    summary,
    scale: SCALE,
    ticks: TICKS,
    ruleNote: "Computed: starts at 100, minus fixed penalties. The model cannot set it.",
    why: {
      label: `Why ${summary.score}`,
      lines: breakdown.map((b) => ({
        rule: b.rule,
        label: convictionRuleLabel(b.rule, b.count, ledger.window),
        count: b.count,
        points: b.points,
        pointsText: b.points < 0 ? `−${Math.abs(b.points)}` : `${b.points}`,
      })),
      total: {
        text: `= ${summary.score}`,
        label: penalties === 0 ? "Starts at 100; no penalties apply" : `Starts at 100; ${countWord(penalties).toLowerCase()} ${penalties === 1 ? "penalty applies" : "penalties apply"}`,
      },
    },
    coverage: evidenceTotal > 0 ? { ok: evidenceOk, total: evidenceTotal, text: `${evidenceOk} of ${evidenceTotal} evidence bundles ok` } : null,
  };
}

const VERDICT_MARK: Readonly<Record<PriorState, { mark: string; word: string }>> = {
  refuted: { mark: "×", word: "REFUTED" },
  confirmed: { mark: "✓", word: "CONFIRMED" },
  inconclusive: { mark: "–", word: "INCONCLUSIVE" },
  awaiting_data: { mark: "·", word: "AWAITING DATA" },
  awaiting_check: { mark: "·", word: "AWAITING CHECK" },
  not_scored: { mark: "·", word: "NOT SCORED" },
};

function buildPriors(ledger: Ledger, notes: FootnoteRegistry): BriefPriors {
  const { state } = ledger;
  const report = state.report;
  const planTs = firstTs(state, "plan");
  const lockedAt = planTs ? formatUtcTime(planTs) : null;
  let items: BriefPrior[];

  if (report && report.scorecard.length > 0) {
    items = report.scorecard.map((row) => {
      const s: PriorState = row.verdict === "REFUTED" ? "refuted" : row.verdict === "CONFIRMED" ? "confirmed" : "inconclusive";
      const label: Inline = { kind: "text", text: "Measured: " };
      const measured = row.note.trim() === "" ? null : [label, ...notes.prose(row.note, "priors")];
      return { id: row.hypothesisId, expected: `We expected: ${row.statement}`, expectation: row.expectation, testTool: row.testTool, state: s, ...VERDICT_MARK[s], measured, progress: null };
    });
  } else {
    const hypotheses = state.plan?.plan.hypotheses ?? [];
    const stopped = stoppedEarly(state);
    items = hypotheses.map((h) => {
      // The opening scan ran before the priors were written; only calls after the plan test them.
      const calls = state.toolCalls.filter((t) => t.tool === h.test_tool && t.phase !== "scan");
      const data = TOOL_DATA_LABEL[h.test_tool];
      const running = calls.some((t) => t.status === "running");
      const ended = calls.length > 0 && !running;
      const s: PriorState = report
        ? "inconclusive"
        : stopped
          ? "not_scored"
          : ended || state.draft !== null
            ? "awaiting_check"
            : "awaiting_data";
      const where = running ? `${data} arriving` : ended ? `${data} in` : `waiting on ${data}`;
      return {
        id: h.id as BriefPrior["id"],
        expected: `We expected: ${h.statement}`,
        expectation: h.expectation,
        testTool: h.test_tool,
        state: s,
        ...VERDICT_MARK[s],
        measured: null,
        progress: report ? null : stopped ? "Run stopped before the check" : ["Written before data", lockedAt, where].filter(Boolean).join(" · "),
      };
    });
  }

  const n = items.length;
  const tally = report
    ? (["refuted", "confirmed", "inconclusive"] as const)
        .map((v) => [v, items.filter((i) => i.state === v).length] as const)
        .filter(([, count]) => count > 0)
        .map(([v, count]) => `${count} ${v}`)
        .join(" · ") || null
    : null;
  return {
    kicker: `${countWord(n)} ${n === 1 ? "prior" : "priors"}, written before any data${lockedAt ? ` · ${lockedAt}` : ""}`,
    lockedAt,
    tally,
    items,
  };
}

function figureFor(
  ledger: Ledger,
  notes: FootnoteRegistry,
  reads: readonly AreaRead[],
  number: number,
  input: { datasetId: BriefFigure["datasetId"]; title: string; caption: string | null; badges: BriefFigure["badges"]; sourceLine: string | null; evidenceIds: BriefFigure["evidenceIds"]; provisional: boolean },
): BriefFigure | null {
  const { state } = ledger;
  const ds = state.datasets[input.datasetId] ?? null;
  const dataset = ds?.data ?? null;
  const kind = dataset?.kind ?? ds?.kind ?? state.report?.exhibits.find((e) => e.datasetId === input.datasetId)?.kind ?? null;
  if (kind === null) return null;
  const evidenceIds = input.evidenceIds.length > 0 ? input.evidenceIds : (dataset?.evidenceIds ?? []);
  const legend = figureLegend(dataset);
  const caption = input.caption ? notes.prose(input.caption, "figures") : [];
  const footnote = notes.figure(input.datasetId, "figures", { title: input.title, evidenceIds, legend });
  // A location figure's fallback steps are cited right after its own note (A06 notes 4 and 5).
  const place = datasetPlace(state, input.datasetId, reads);
  const fallbackNotes = (place?.fallbacks ?? []).map((i) => notes.fallback(i, "figures"));
  const formulaIds = dataset?.formulaIds ?? [];
  return {
    number,
    datasetId: input.datasetId,
    kind,
    viz: VIZ_COMPAT[kind],
    title: input.title,
    caption,
    footnote,
    badges: input.badges,
    dataset,
    needsFetch: dataset === null,
    datasetUrl: `/api/runs/${encodeURIComponent(state.runId)}/datasets/${input.datasetId}`,
    legend,
    source: figureSource(ledger, evidenceIds, input.sourceLine, place),
    evidenceIds,
    formulaIds,
    methodHref: methodHrefFor(formulaIds),
    provisional: input.provisional,
    location: place ? { place: place.place, method: place.method, text: place.method ? `read by ${place.method}` : null, fallbackNotes } : null,
  };
}

/** Datasets as they arrive, before the report names its exhibits (the Scorecard is the priors block). */
function liveDatasets(state: RunState) {
  return Object.values(state.datasets)
    .filter((d) => d.kind !== "Scorecard")
    .sort((a, b) => a.seq - b.seq);
}

function buildEvidence(ledger: Ledger, notes: FootnoteRegistry, live: LiveKeyFigure[] | null): BriefEvidence {
  const { state } = ledger;
  const report = state.report;
  const total = state.qloo.chips.length;

  const job = report?.job ?? state.intent?.job;
  const readyFigure = (metric: Metric, label: string | null, comparator: Metric["comparator"]): BriefKeyFigure => {
    const text = keyFigureText(ledger, job, metric, label, comparator);
    return {
      key: metric.id,
      state: "ready",
      metric: metricView(metric, ledger.window),
      value: text.value,
      footnote: notes.metric(metric.id, "key_figures"),
      label: text.label,
      comparator: text.comparator,
      pendingNote: null,
    };
  };
  const keyFigures: BriefKeyFigure[] = report
    ? report.kpis.map((k) => {
        const metric = state.metrics[k.metricId];
        if (!metric) return { key: k.metricId, state: "pending", metric: null, value: null, footnote: null, label: capitalize(k.label), comparator: null, pendingNote: "not streamed" };
        return readyFigure(metric, k.label, k.comparator);
      })
    : (live ?? []).map((k, i) => {
        if (!k.metric) return { key: `pending-${i}`, state: "pending", metric: null, value: null, footnote: null, label: k.label, comparator: null, pendingNote: k.pendingNote };
        // Named by its key's spec, as the finished brief names it: the slot's label held only its place.
        return readyFigure(k.metric, null, k.metric.comparator);
      });

  const reads = areaReads(state);
  const figures: BriefFigure[] = [];
  if (report) {
    for (const ex of report.exhibits) {
      if (ex.kind === "Scorecard") continue;
      const figure = figureFor(ledger, notes, reads, figures.length + 1, {
        datasetId: ex.datasetId,
        title: ex.title,
        caption: ex.caption,
        badges: ex.badges,
        sourceLine: ex.sourceLine,
        evidenceIds: ex.evidenceIds,
        provisional: false,
      });
      if (figure) figures.push(figure);
    }
  } else {
    for (const d of liveDatasets(state)) {
      const figure = figureFor(ledger, notes, reads, figures.length + 1, {
        datasetId: d.id,
        title: d.title,
        caption: null,
        badges: [],
        sourceLine: null,
        evidenceIds: d.data?.evidenceIds ?? [],
        provisional: true,
      });
      if (figure) figures.push(figure);
    }
  }

  const args: BriefArgument[] = (report?.arguments ?? []).map((a) => ({
    id: a.id,
    section: a.section,
    sectionLabel: SECTION_LABEL[a.section],
    strength: a.strength,
    strengthLabel: STRENGTH_LABEL[a.strength],
    qlooFact: notes.prose(a.qlooFact, "arguments"),
    ourRead: notes.prose(a.ourRead, "arguments"),
  }));

  const figureCalls = new Set(figures.flatMap((f) => requestsForEvidence(ledger, f.evidenceIds).map((r) => r.qlooCallId))).size;
  const ready = keyFigures.filter((k) => k.state === "ready").length;
  const still = stoppedEarly(state) ? "run stopped" : "exhibits drafted last";
  const aside = report
    ? `${plural(figures.length, "figure")} · ${figureCalls > 0 && figureCalls < total ? `${figureCalls} of ${total} requests` : plural(total, "request")}`
    : keyFigures.length > 0
      ? `${ready} of ${keyFigures.length} key figures in · ${still}`
      : `${plural(total, "request")} in · ${still}`;

  return {
    aside,
    keyFigures,
    figures,
    arguments: args,
    recommendations: (report?.recommendations ?? []).map((r) => ({
      action: r.action,
      priority: r.priority,
      priorityLabel: PRIORITY_LABEL[r.priority],
      argumentIds: r.argumentIds,
    })),
  };
}

function buildRisks(ledger: Ledger, notes: FootnoteRegistry): BriefRisks {
  const report = ledger.state.report;
  if (!report) return { changes: [], limitations: [] };
  return {
    changes: report.bearCase.map((b, i) => {
      const condition = notes.prose(b.text, "risks");
      const id = b.metricIds[0];
      const metric = id ? ledger.state.metrics[id] : undefined;
      return {
        n: i + 1,
        condition,
        now: id && metric ? { metric: metricView(metric, ledger.window), footnote: notes.metric(id, "risks") } : null,
        trigger: null,
      };
    }),
    limitations: report.limitations.map((l) => ({ text: l.text, source: l.source, flag: l.flag, flagLabel: l.flag ? flagLabel(l.flag) : null })),
  };
}

function buildTerminal(state: RunState): BriefTerminal | null {
  if (state.needsInput) {
    const n = state.needsInput;
    const reasonLabel = n.reason === "ambiguous" ? "Several entities share this name" : MATCH_LABEL[n.reason].replace(/^./, (c) => c.toUpperCase());
    return {
      kind: "needs_input",
      mention: n.mention,
      entityType: n.entityType,
      reason: n.reason,
      reasonLabel,
      candidates: n.candidates,
      message:
        n.candidates.length > 0
          ? `"${n.mention}" did not match one ${n.entityType.replace(/_/g, " ")} exactly. Pick the one you mean and the brief runs again.`
          : `"${n.mention}" was not found. Ask again with another name.`,
    };
  }
  const ended = state.ended;
  if (!ended) return null;
  switch (ended.status) {
    case "completed":
    case "needs_input":
      return null;
    case "refused": {
      const category = state.intent?.safety.category ?? null;
      const reframe = state.intent?.safety.reframe ?? null;
      const categoryLabel = category ? SAFETY_LABEL[category] : null;
      // An ANALYST refusal comes after the evidence was gathered: only CLERK refuses before any request.
      const before = state.qloo.chips.length === 0 ? " before any data was requested" : "";
      return {
        kind: "refused",
        category,
        categoryLabel,
        reframe,
        message: `This question was refused${before}${categoryLabel ? `: ${categoryLabel.toLowerCase()}` : ""}.`,
      };
    }
    case "failed":
      return {
        kind: "failed",
        reason: ended.reason,
        errors: state.errors.map((e) => ({ code: e.code, message: e.message })),
        message: `The run failed${ended.reason ? `: ${ended.reason}` : ""}.`,
      };
    case "cancelled":
      return { kind: "cancelled", reason: ended.reason, message: "The run was stopped before the brief was written." };
    case "incomplete":
      return {
        kind: "incomplete",
        badge: "INCOMPLETE",
        reason: ended.reason,
        message: state.report
          ? `Incomplete: the analyst did not finish, so this brief is a digest of the evidence${ended.reason ? ` (${ended.reason})` : ""}.`
          : `Incomplete: the run stopped before a brief${ended.reason ? ` (${ended.reason})` : ""}.`,
      };
  }
}

const WORDS_PER_MINUTE = 200;
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

function readMinutes(model: { answer: BriefAnswer; priors: BriefPriors; evidence: BriefEvidence; risks: BriefRisks }): number {
  const texts = [
    inlineText(model.answer.headline),
    inlineText(model.answer.thesis),
    ...model.priors.items.flatMap((p) => [p.expected, inlineText(p.measured)]),
    ...model.evidence.keyFigures.map((k) => k.label),
    ...model.evidence.figures.map((f) => `${f.title} ${inlineText(f.caption)}`),
    ...model.evidence.arguments.flatMap((a) => [inlineText(a.qlooFact), inlineText(a.ourRead)]),
    ...model.risks.changes.map((c) => inlineText(c.condition)),
    ...model.risks.limitations.map((l) => l.text),
  ];
  const words = texts.reduce((n, t) => n + countWords(t), 0);
  // Half a minute per figure for reading the plot.
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE + model.evidence.figures.length * 0.5));
}

export function buildBriefModel(state: RunState, now: number): BriefModel {
  const ledger = buildLedger(state);
  const report = state.report;
  const notes = new FootnoteRegistry(ledger);

  // Live: number what is on the page in the order it arrived.
  const live = report ? null : liveKeyFigures(ledger);
  if (!report) {
    const items = [
      ...(live ?? []).flatMap((k) => (k.metric ? [{ kind: "metric" as const, key: k.metric.id, section: "key_figures" as const, seq: arrivedAt(ledger, "metric", k.metric.id) }] : [])),
      ...liveDatasets(state).map((d) => ({ kind: "figure" as const, key: d.id, section: "figures" as const, seq: d.seq })),
    ].sort((a, b) => a.seq - b.seq);
    notes.preassign(items);
  }

  // Reading order: each builder cites as it goes.
  const answer = buildAnswer(state, notes);
  const conviction = buildConviction(ledger);
  const priors = buildPriors(ledger, notes);
  const evidence = buildEvidence(ledger, notes, live);
  const risks = buildRisks(ledger, notes);
  const footnotes = notes.list();
  const fallbackNotes = new Map(footnotes.filter((f) => f.kind === "fallback").map((f) => [Number(f.key), f.n]));

  const sources = buildSources(ledger);
  for (const note of footnotes) {
    for (const r of note.requests) {
      const item = r.sourceIndex === null ? undefined : sources.items[r.sourceIndex];
      if (item && !item.footnotes.includes(note.n)) item.footnotes.push(note.n);
    }
  }
  const citedSources = sources.items.filter((s) => s.footnotes.length > 0).length;
  const method = buildMethod(state);

  const pillar = report?.pillar ?? state.intent?.pillar ?? null;
  const job = report?.job ?? state.intent?.job ?? null;
  const briefId = briefIdOf(state.runId);
  const chipCount = state.qloo.chips.length;
  const sourceCount = chipCount > 0 || !report ? chipCount : report.receipt.qlooNetwork + report.receipt.qlooCached + report.receipt.qlooReused;
  const minutes = report ? readMinutes({ answer, priors, evidence, risks }) : null;
  const liveBlock = buildLive(ledger, now);
  const header: BriefHeader = {
    pillar,
    deskLabel: pillar ? DESK_LABEL[pillar] : null,
    job,
    jobLabel: job ? JOB_HEAD_LABEL[job] : null,
    mnemonic: state.intent?.mnemonic ?? null,
    question: report?.question ?? state.question,
    signal: signalTag(report),
    finding: findingOf(report),
    conviction: convictionSummary(report),
    briefId,
    briefLabel: `Brief ${briefId}`,
    date: state.createdAt ? formatUtcDate(state.createdAt) : null,
    readMinutes: minutes,
    figureCount: evidence.figures.length,
    sourceCount,
    footer:
      minutes !== null
        ? `${minutes} min read · ${plural(evidence.figures.length, "figure")} · ${plural(sourceCount, "source")}`
        : (liveBlock?.since ?? `${plural(evidence.figures.length, "figure")} · ${plural(sourceCount, "source")}`),
    parentRunId: state.parentRunId,
    investmentBanner: report?.investmentBanner ?? pillar === "investment",
    incomplete: report?.incomplete ?? state.status === "incomplete",
  };

  const ended = state.ended !== null;
  const outline: OutlineEntry[] = [
    { id: "answer", number: "01", label: "Answer", available: true },
    { id: "conviction", number: "02", label: "Conviction", available: true },
    { id: "evidence", number: "03", label: "Evidence", available: report !== null || evidence.keyFigures.some((k) => k.state === "ready") || evidence.figures.length > 0 },
    { id: "risks", number: "04", label: "Risks", available: risks.changes.length + risks.limitations.length > 0 },
    { id: "method", number: "05", label: "Method", available: report !== null || (ended && method.steps.length > 0) },
    { id: "sources", number: "06", label: "Sources", available: report !== null || (ended && chipCount > 0) },
  ];

  const snapshotIso = report?.dataFreshness.fetchedTo ?? state.createdAt;
  const snapshot = snapshotIso ? formatUtcDate(snapshotIso) : null;
  const cached = state.qloo.cached + state.qloo.reused;
  const statusLine: BriefStatusLine = {
    honesty: ["Analytics, not financial advice", "Group-level taste data", "No individuals", snapshot ? `Snapshot ${snapshot}` : null].filter(Boolean).join(" · "),
    snapshot,
    window: ledger.window ? `Trend window ${formatTrendWindow(ledger.window)}` : null,
    requests: `Qloo ${sourceCount} req · ${cached} cached`,
  };

  return {
    runId: state.runId,
    mode: report ? "final" : "live",
    status: state.status,
    header,
    outline,
    answer,
    conviction,
    priors,
    evidence,
    risks,
    method,
    sources,
    footnotes,
    trace: traceNote(state, citedSources),
    live: liveBlock,
    terminal: buildTerminal(state),
    location: buildLocation(state, fallbackNotes),
    nextMoves: buildNextMoves(report?.nextMoves ?? [], state.runId, pillar),
    disclaimers: report?.disclaimers ?? [...FIXED_DISCLAIMERS],
    statusLine,
  };
}

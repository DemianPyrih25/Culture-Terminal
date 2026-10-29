import { METRO_LABEL, MetroId, type GhostPickCategory, type Job } from "@ct/contracts";
import { buildGhostView, ghostOf, inlineText, type BriefModel, type Inline } from "../brief";
import { cityFingerprints, selectFigures, shapeChart, moreCharts, type ChartContext } from "./charts";
import {
  ADVICE_LINE,
  ANSWER_JOB_LABEL,
  GHOST_JOB_CATEGORY,
  GHOST_NOUN,
  GHOST_OBVIOUS_POINTS,
  GHOST_OBVIOUS_TITLE,
  METRO_STATE,
  NOT_ENOUGH_LINE,
  PILLAR_TOPIC,
  PLACE_JOBS,
  TOPIC_LABEL,
  wordList,
} from "./copy";
import { marketLabel } from "./markets";
import { buildKeyNumbers } from "./key-numbers";
import type {
  AnswerArea,
  AnswerCell,
  AnswerChart,
  AnswerDatasets,
  AnswerGhost,
  AnswerHead,
  AnswerModel,
  AnswerReadAs,
  AnswerRun,
  AnswerStep,
  AnswerSubjects,
  AnswerVerdict,
} from "./types";

/**
 * buildAnswerModel: a finished run's BriefModel (and the run it came from) into the answer page's
 * view-model. Pure; safe on the server and in the browser. Each job picks its key numbers and charts
 * (./key-numbers, ./charts); the rest (verdict, next steps, guesses, AI alone, what could change this,
 * why, more charts, ask next) reads the same for every job.
 */

const CHANGES_MAX = 3;
const GHOST_NAMES = 5;

/** The resolved primary subject and the second one (a head-to-head's other brand). */
export function answerSubjects(run: AnswerRun): AnswerSubjects {
  const exact = run.resolves.filter((r) => r.ref !== null);
  const primary = exact.find((r) => r.role === "primary") ?? exact[0] ?? null;
  const second = exact.find((r) => r !== primary && (r.role === "peer" || r.role === "secondary")) ?? null;
  return { primary, second };
}

/** "ZIP 37206 (East Nashville)" reads "East Nashville". */
export function areaName(name: string): string {
  const inner = /\(([^)]+)\)\s*$/.exec(name)?.[1]?.trim();
  return inner && inner !== "" ? inner : name;
}

/** The map city a location's city names ("New York City" → nyc), by its label. */
function metroOf(city: string | null): MetroId | null {
  const key = city?.trim().toLowerCase();
  return MetroId.options.find((m) => METRO_LABEL[m].toLowerCase() === key) ?? null;
}

/**
 * The place a place answer reads: "Austin, TX" for a site search, the area's name for a block, "East
 * Side → Denver" for a twin search, "Austin, Denver and Nashville" for a city comparison. The twin's
 * target and the compared cities come from the run's reading when the page has it.
 */
export function answerPlace(model: BriefModel, intent: AnswerRun["intent"] = null): string | null {
  const job = model.header.job;
  if (job === "city_compare") {
    const cities = intent?.geo.cities ?? [];
    return cities.length > 0 ? wordList(cities.map(marketLabel), "and") : (model.location?.city ?? null);
  }
  if (!job || !PLACE_JOBS.has(job) || !model.location) return null;
  const city = model.location.city;
  if (job === "taste_twins") {
    const source = model.location.areas[0]?.name;
    const from = source ? areaName(source) : city;
    const target = intent?.geo.target_metro ? METRO_LABEL[intent.geo.target_metro] : null;
    return from && target ? `${from} → ${target}` : (from ?? target);
  }
  if (job === "site_selection") {
    const metro = metroOf(city);
    return city ? (metro ? `${city}, ${METRO_STATE[metro]}` : city) : null;
  }
  const area = model.location.areas[0]?.name;
  return area ? areaName(area) : city;
}

function buildHead(model: BriefModel, fallbackQuestion: string | null, subjects: AnswerSubjects, intent: AnswerRun["intent"]): AnswerHead {
  const { header } = model;
  const topic = header.pillar ? PILLAR_TOPIC[header.pillar] : null;
  const job = header.job;
  const place = answerPlace(model, intent);
  const date = header.date;
  const eyebrow = [topic ? TOPIC_LABEL[topic] : null, job ? ANSWER_JOB_LABEL[job] : null, place, date ? `Data as of ${date}` : null].filter(Boolean).join(" · ");
  const mobileEyebrow = [topic ? TOPIC_LABEL[topic] : null, date].filter(Boolean).join(" · ");
  const compare =
    job === "head_to_head" && subjects.primary && subjects.second
      ? { subject: subjects.primary.name ?? subjects.primary.mention, second: subjects.second.name ?? subjects.second.mention }
      : null;
  return { topic, eyebrow, mobileEyebrow, question: header.question ?? fallbackQuestion ?? "", compare };
}

const NEAREST_FLAG = "READ_AS_NEAREST_JOB";
const CONCEPT_FLAG = "CONCEPT_NOT_IN_DATA";

/**
 * The concept note (the owner's o03 decision): the CONCEPT_NOT_IN_DATA limitation's sentence, which the
 * agent writes with the names ("The exact product, "X", is not in the data, so the category "Y" was
 * tested instead."); null when the report has none.
 */
export function buildConceptNote(model: BriefModel): string | null {
  const text = model.risks.limitations.find((l) => l.flag === CONCEPT_FLAG)?.text.replace(/\s+/g, " ").trim() ?? "";
  return text === "" ? null : text;
}

const NEAREST_FALLBACK = "This answers the closest question we cover, not every part of what you asked.";

/** "Not covered: sales and rents. We have no data on these, so this answer leaves them out." */
function notCoveredSentence(items: readonly string[]): string {
  const one = items.length === 1;
  return `Not covered: ${wordList(items, "and")}. We have no data on ${one ? "this" : "these"}, so this answer leaves ${one ? "it" : "them"} out.`;
}

/**
 * The nearest-job chip (D41, ANSWER_QUALITY §8): from the method view's interpretation, else the run's
 * reading, else the READ_AS_NEAREST_JOB limitation; null when the question fit its job.
 */
export function buildReadAs(model: BriefModel, intent: AnswerRun["intent"] = null): AnswerReadAs | null {
  const job = model.header.job;
  const jobLabel = job ? ANSWER_JOB_LABEL[job] : null;
  const clean = (items: readonly string[]) => [...new Set(items.map((i) => i.replace(/\s+/g, " ").trim()).filter((i) => i !== ""))];
  const limitation = model.risks.limitations.find((l) => l.flag === NEAREST_FLAG)?.text.trim() || null;
  const mapped = model.method.interpretation?.readAs ?? null;
  if (mapped) {
    const notCovered = clean(mapped.notCovered);
    const label = mapped.jobLabel.trim() || jobLabel;
    if (!label) return null;
    return { jobLabel: label, notCovered, text: notCovered.length > 0 ? notCoveredSentence(notCovered) : (limitation ?? NEAREST_FALLBACK) };
  }
  if (intent?.read_as?.nearest && jobLabel) {
    const notCovered = clean(intent.read_as.not_covered);
    return { jobLabel, notCovered, text: notCovered.length > 0 ? notCoveredSentence(notCovered) : (limitation ?? NEAREST_FALLBACK) };
  }
  return limitation && jobLabel ? { jobLabel, notCovered: [], text: limitation } : null;
}

const withPeriod = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A sentence ends in . ! or ?, perhaps inside a closing quote or bracket. */
const ENDED = /[.!?]["'’”)\]]*$/;

/**
 * The headline as a full sentence (the design ends it with a full stop): a period after its last visible
 * piece when the report left it off. Citations print for screen readers only, so the period goes before
 * them.
 */
export function headlineWithPeriod(inlines: readonly Inline[] | null): Inline[] | null {
  if (!inlines) return null;
  const out = inlines.slice();
  let last = out.length - 1;
  while (last >= 0) {
    const piece = out[last] as Inline;
    if (piece.kind === "cite" || (piece.kind === "text" && piece.text.trim() === "")) last -= 1;
    else break;
  }
  if (last < 0) return out;
  const piece = out[last] as Inline;
  if (piece.kind === "text") {
    const text = piece.text.trimEnd();
    if (!ENDED.test(text)) out[last] = { kind: "text", text: `${text}.` };
  } else if (piece.kind === "metric" || piece.kind === "cite" || !ENDED.test(piece.text.trimEnd())) {
    out.splice(last + 1, 0, { kind: "text", text: "." });
  }
  return out;
}

/** "Qloo", "Qloo and SEC": the sources the run's evidence came from, Qloo first. */
function sourcesOf(run: AnswerRun): string {
  const have = new Set(Object.values(run.evidence ?? {}).map((e) => e.source ?? "qloo"));
  const names = [...(have.size === 0 || have.has("qloo") ? ["Qloo"] : []), ...(have.has("sec") ? ["SEC"] : []), ...(have.has("census") ? ["Census"] : [])];
  return wordList(names, "and");
}

function buildVerdict(model: BriefModel, run: AnswerRun): AnswerVerdict {
  const { header, answer, conviction, method } = model;
  const notEnough = answer.signal?.signal === "insufficient_evidence";
  const line = notEnough ? NOT_ENOUGH_LINE : (header.finding ?? answer.signal?.label ?? "");
  const checker = method.checker;
  let check: AnswerVerdict["check"] = null;
  if (checker.traced !== null && checker.total !== null && checker.total > 0) {
    const ok = checker.state === "passed" && checker.traced === checker.total;
    const against = `against ${sourcesOf(run)} data`;
    check = ok ? { ok, text: `All ${checker.total} numbers checked ${against}` } : { ok, text: `${checker.traced} of ${checker.total} numbers checked ${against}` };
  }
  return {
    kind: notEnough ? "not_enough" : "answer",
    line: notEnough || line === "" ? line : withPeriod(line),
    headline: headlineWithPeriod(answer.headline),
    confidence: notEnough ? "insufficient_evidence" : (conviction.summary?.band ?? header.conviction?.band ?? null),
    lowered: conviction.why ? conviction.why.lines.filter((l) => l.points < 0 || l.pointsText.startsWith("−")).map((l) => l.label) : [],
    advice: header.investmentBanner || header.pillar === "investment" ? ADVICE_LINE : null,
    check,
  };
}

const PRIORITY_WORD = { now: "Now", next: "Next", later: "Later" } as const;

/** First the first step of each priority (now, next, later), then the rest in report order. */
export function buildSteps(model: BriefModel): AnswerStep[] {
  const recs = model.evidence.recommendations;
  const first = (["now", "next", "later"] as const).map((p) => recs.find((r) => r.priority === p)).filter((r) => r !== undefined);
  const rest = recs.filter((r) => !first.includes(r));
  return [...first, ...rest].map((r) => ({ word: PRIORITY_WORD[r.priority], text: r.action }));
}

/** AI alone (GHOST): the job's first pick list beside the data's, with the title rule of §2.6. */
export function buildGhost(job: Job | null, run: AnswerRun): AnswerGhost | null {
  const raw = ghostOf(run);
  const view = buildGhostView(raw);
  if (!raw || !view) return null;
  const want: GhostPickCategory | null = job ? GHOST_JOB_CATEGORY[job] : null;
  const cat = view.categories.find((c) => c.category === want) ?? view.categories[0];
  if (!cat) return null;
  const ai = cat.ghost.slice(0, GHOST_NAMES).map((n) => ({ name: n.name, both: n.status === "both" }));
  const data = cat.qloo.slice(0, GHOST_NAMES).map((n) => ({ name: n.name, both: n.status === "both" }));
  const k = ai.filter((n) => n.both).length;
  const noun = GHOST_NOUN[cat.category];
  const { ghost: gp, qloo: qp } = raw.diff.meanPopularity;
  const points = (p: number) => (p > 1 ? p : p * 100);
  const obvious = gp !== null && qp !== null && points(gp) - points(qp) >= GHOST_OBVIOUS_POINTS;
  const title = obvious ? GHOST_OBVIOUS_TITLE[cat.category] : k === 0 ? `AI alone named different ${noun}` : `AI alone matched ${k} of the data's top 5 ${noun}`;
  const areas = cat.category === "neighbourhoods" ? " areas" : "";
  const subline = `Same AI, no data. ${k} of its top 5${areas} ${k === 1 ? "matches" : "match"} the data's top 5.`;
  return { category: cat.category, title, subline, ai, data };
}

export function buildChanges(model: BriefModel, readAsShown = false, conceptShown = false): string[] {
  const out: string[] = [];
  for (const c of model.risks.changes) {
    const text = inlineText(c.condition).replace(/\s+/g, " ").trim();
    if (text !== "") out.push(text);
  }
  for (const l of model.risks.limitations) {
    // A boundary credit is an attribution the map keeps, not a caveat.
    if (/^Boundaries\s*©/i.test(l.text)) continue;
    // What the question asked beyond its job already leads the page (the Read as chip).
    if (readAsShown && l.flag === NEAREST_FLAG) continue;
    // So does a concept the data does not hold (the concept note).
    if (conceptShown && l.flag === CONCEPT_FLAG) continue;
    out.push(l.text.trim());
  }
  return out.slice(0, CHANGES_MAX);
}

/** The public figures (SEC financials, Census economics) take a row of their own under the taste read. */
const THIRD_ROW: readonly AnswerCell[] = [{ slot: "third", span: 6 }];

/** Rows C and D per job (§2.7–2.10): which chart slot sits where, then cells with nothing to show drop out. */
const LAYOUT: Readonly<Record<Job, AnswerCell[][]>> = {
  brand_health: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }]],
  head_to_head: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }]],
  market_selection: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }]],
  site_selection: [[{ slot: "map", span: 6 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }], [...THIRD_ROW]],
  sponsorship: [[{ slot: "main", span: 6 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }]],
  tenant_mix: [[{ slot: "map", span: 3 }, { slot: "main", span: 3 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }], [...THIRD_ROW]],
  area_profile: [[{ slot: "map", span: 3 }, { slot: "main", span: 3 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }], [...THIRD_ROW]],
  audience_discovery: [[{ slot: "main", span: 3 }, { slot: "guesses", span: 3 }], [{ slot: "second", span: 6 }]],
  taste_twins: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }], [{ slot: "third", span: 6 }]],
  brand_collab: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }]],
  creator_fit: [[{ slot: "main", span: 6 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }]],
  launch_test: [[{ slot: "main", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "second", span: 6 }], [{ slot: "third", span: 6 }]],
  city_compare: [[{ slot: "main", span: 6 }], [{ slot: "second", span: 4 }, { slot: "guesses", span: 2 }], [{ slot: "third", span: 6 }]],
};

const GHOST_WIDE: ReadonlySet<Job> = new Set<Job>(["brand_health", "head_to_head", "audience_discovery"]);

/** The rows with only what the answer has; a cell left alone in its row takes the whole row. */
export function layoutRows(job: Job | null, has: { main: boolean; second: boolean; third?: boolean; map: boolean; guesses: boolean }): AnswerCell[][] {
  const plan: readonly AnswerCell[][] = job ? LAYOUT[job] : LAYOUT.brand_health;
  const rows: AnswerCell[][] = [];
  for (const row of plan) {
    const kept = row.filter((c) => has[c.slot] === true);
    if (kept.length === 0) continue;
    if (kept.length === 1) {
      const only = kept[0] as AnswerCell;
      rows.push([only.slot === "guesses" ? { slot: "guesses", span: 6 } : { slot: only.slot, span: 6 }]);
    } else rows.push(kept);
  }
  return rows;
}

/** Where the answer's cells go: rows C and D, and whether the guesses moved down beside Change (row E). */
export interface AnswerLayout {
  rows: AnswerCell[][];
  guessesBesideChange: boolean;
}

/**
 * layoutRows, then a home for guesses left alone in their row (a whole row of short lines): with no AI
 * alone card they sit beside Change in row E (4 + 2); otherwise beside a chart that is alone in the row
 * above or below (4 + 2). Only when neither fits do they keep the whole row.
 */
export function answerLayout(job: Job | null, has: { main: boolean; second: boolean; third?: boolean; map: boolean; guesses: boolean }, ghost: boolean): AnswerLayout {
  const rows = layoutRows(job, has);
  const at = rows.findIndex((r) => r.length === 1 && r[0]?.slot === "guesses");
  if (at < 0) return { rows, guessesBesideChange: false };
  if (!ghost) return { rows: rows.filter((_, i) => i !== at), guessesBesideChange: true };
  const beside = [at - 1, at + 1].find((i) => rows[i]?.length === 1 && rows[i]?.[0]?.slot !== "guesses");
  if (beside === undefined) return { rows, guessesBesideChange: false };
  const chart = rows[beside]?.[0] as AnswerCell;
  const merged: AnswerCell[] = [{ ...chart, span: 4 } as AnswerCell, { slot: "guesses", span: 2 }];
  return { rows: rows.flatMap((r, i) => (i === at ? [] : i === beside ? [merged] : [r])), guessesBesideChange: false };
}

function placeholderOf(model: BriefModel, subjects: AnswerSubjects, intent: AnswerRun["intent"]): string {
  const job = model.header.job;
  if (job && PLACE_JOBS.has(job)) {
    const source = model.location?.areas[0]?.name;
    const place =
      job === "site_selection" ? model.location?.city : job === "taste_twins" ? (source ? areaName(source) : model.location?.city) : answerPlace(model, intent);
    if (place) return `Ask a follow-up about ${place}`;
  }
  const names = [subjects.primary, job === "head_to_head" ? subjects.second : null]
    .filter((r) => r !== null)
    .map((r) => r.name ?? r.mention);
  if (names.length === 0) {
    const fromModel = model.method.interpretation?.subjects.slice(0, job === "head_to_head" ? 2 : 1) ?? [];
    names.push(...fromModel);
  }
  return names.length > 0 ? `Ask a follow-up about ${names.join(" and ")}` : "Ask a follow-up about this answer";
}

/** The area a block answer reads, for the area map (tenant_mix with the corner pin, area_profile without). */
export function answerArea(model: BriefModel): AnswerArea | null {
  const job = model.header.job;
  if (job !== "tenant_mix" && job !== "area_profile") return null;
  const metro = metroOf(model.location?.city ?? null);
  const name = model.location?.areas[0]?.name;
  if (!metro || !name) return null;
  return { metro, name, label: areaName(name), corner: job === "tenant_mix" };
}

export interface BuildAnswerOptions {
  /** Datasets fetched after the first paint (large ones are not streamed inline). */
  datasets?: AnswerDatasets;
  /** The question from the run row, until run.created arrives. */
  fallbackQuestion?: string | null;
}

export function buildAnswerModel(model: BriefModel, run: AnswerRun, options: BuildAnswerOptions = {}): AnswerModel {
  const fetched = options.datasets ?? {};
  const job = model.header.job;
  const subjects = answerSubjects(run);
  const ctx: ChartContext = {
    job,
    subjectRef: subjects.primary?.ref ?? null,
    subject: subjects.primary ? (subjects.primary.name ?? subjects.primary.mention) : (model.method.interpretation?.subjects[0] ?? null),
    secondRef: subjects.second?.ref ?? null,
    second: subjects.second ? (subjects.second.name ?? subjects.second.mention) : (model.method.interpretation?.subjects[1] ?? null),
    city: model.location?.city ?? null,
    subjectType: subjects.primary?.entityType ?? null,
  };
  const figures = model.evidence.figures;
  const picked = selectFigures(job, figures, fetched);
  const charts: AnswerModel["charts"] = {
    main: shapeChart(picked.main, ctx, figures, fetched),
    second: shapeChart(picked.second, ctx, figures, fetched),
    third: shapeChart(picked.third, ctx, figures, fetched),
    map: shapeChart(picked.map, ctx, figures, fetched),
  };
  const used = new Set<string>(
    (Object.values(charts).filter((c) => c !== null) as AnswerChart[]).map((c) => c.datasetId),
  );
  // A figure whose data is still loading keeps its slot out of More charts too.
  for (const f of Object.values(picked)) if (f) used.add(f.datasetId);
  // head_to_head draws its age figure inside "Who wins where".
  if (job === "head_to_head" && charts.main?.body.type === "winner") {
    for (const f of figures) if (f.kind === "Bars" && f.datasetId !== charts.main.datasetId && f.dataset?.kind === "Bars" && f.dataset.payload.groups.some((g) => g.key === "AGE")) used.add(f.datasetId);
  }
  // city_compare draws every city's fingerprint inside its one card.
  if (job === "city_compare" && charts.main?.body.type === "neighbours") {
    for (const p of cityFingerprints(figures, fetched)) used.add(p.datasetId);
  }
  const guesses = model.priors.items.length;
  const area = answerArea(model);
  // A lift map whose data is still on its way (undefined: loading; null: the fetch failed) keeps the map's row.
  const mapPending = job === "site_selection" && charts.map === null && figures.some((f) => f.kind === "GeoLift" && f.dataset === null && fetched[f.datasetId] === undefined);
  const ghost = model.terminal?.kind === "refused" || model.terminal?.kind === "needs_input" ? null : buildGhost(job, run);
  const intent = run.intent ?? null;
  const readAs = buildReadAs(model, intent);
  const concept = buildConceptNote(model);
  return {
    runId: model.runId,
    job,
    head: buildHead(model, options.fallbackQuestion ?? null, subjects, intent),
    concept,
    readAs,
    verdict: buildVerdict(model, run),
    steps: buildSteps(model),
    keyNumbers: buildKeyNumbers({
      job,
      figures: model.evidence.keyFigures,
      metrics: run.metrics ?? {},
      allFigures: figures,
      fetched,
      ctx,
      askedArea: model.method.interpretation?.area ?? null,
    }),
    charts,
    area,
    mapPending,
    ...answerLayout(
      job,
      { main: charts.main !== null, second: charts.second !== null, third: charts.third !== null, map: charts.map !== null || area !== null || mapPending, guesses: guesses > 0 },
      ghost !== null,
    ),
    ghost,
    ghostSpan: job && GHOST_WIDE.has(job) ? 3 : 4,
    changes: buildChanges(model, readAs !== null, concept !== null),
    why: { count: model.evidence.arguments.length, thesis: model.answer.thesis, arguments: model.evidence.arguments },
    more: moreCharts(figures, used, fetched),
    ask: { moves: model.nextMoves, placeholder: placeholderOf(model, subjects, intent) },
  };
}

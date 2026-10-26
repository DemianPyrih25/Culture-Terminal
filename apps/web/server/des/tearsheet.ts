import "server-only";
import { EntityType, entityTypeUrn, type DatasetEnvelope, type Evidence, type Flag, type Metric, type SkillId, type SkillResult } from "@ct/contracts";
import type { LedgerSnapshot } from "@ct/agent";
import type { QlooCallRecord } from "@ct/qloo";
import { DESK_LIMITATIONS, flagText, orderFlags, SKILLS } from "@ct/quant";
import { desMnemonic, type DesType } from "../../components/des/des-href";
import type {
  DesFigure,
  DesKeyFigure,
  DesReceipt,
  DesSection,
  DesSectionId,
  DesSource,
  Tearsheet,
} from "../../components/des/model";
import { sourceFromEvidence } from "../../components/figures/source";
import { filterLabel, formatCacheAge, NOT_MEASURED } from "../../lib/brief/format";

/**
 * The tearsheet from what one DES lookup recorded: the run ledger's evidence, metrics and datasets,
 * and the Qloo calls in the order they were made. Code only: every title and key figure is read from
 * a dataset or a metric, so every number on the page traces to a request in Receipts. Nothing here
 * carries a Qloo entity id or request parameters (components/des/model.ts).
 */

/** How one section's skill went. */
export type SectionRun =
  | { kind: "ran"; skill: SkillId; result: SkillResult }
  /** The skill threw: a bug or a failure no skill result describes. */
  | { kind: "failed"; skill: SkillId; message: string };

export interface SheetInput {
  query: { name: string; type: DesType };
  /** The reader chose the entity from Qloo's candidates (a pick applied as a pin). */
  picked: boolean;
  entity: { name: string; type: DesType; disambiguation: string | null };
  computedAt: string;
  snapshot: LedgerSnapshot;
  calls: readonly QlooCallRecord[];
  sections: Record<DesSectionId, SectionRun>;
  /** The popularity metric the lookup recorded from the resolving /search; null when Qloo gave none. */
  popularity: Metric | null;
}

/** The skill behind each section. */
export const SECTION_SKILL: Readonly<Record<DesSectionId, SkillId>> = {
  dna: "audience_dna",
  neighbours: "cross_domain",
  travel: "destination_affinity",
};

const FAILED_GAP = "This part could not be computed just now; the other sections stand on their own requests.";
const TRUNCATED_REASON = "the lookup reached its Qloo call budget";
const TRUNCATED_GAP = `This part was not requested: ${TRUNCATED_REASON}.`;
const PARTIAL_GAP = "Part of this came back without a value; those rows show as not measured.";
const EMPTY_GAP: Readonly<Record<DesSectionId, string>> = {
  dna: "Qloo holds no demographics block or tags for this entity, so its audience DNA is not measured.",
  neighbours: "Qloo returned no cultural neighbours for this entity's audience.",
  travel: "Qloo returned no destinations for this entity's audience.",
};

// Receipts ---------------------------------------------------------------------------------------------

function cacheLabel(call: QlooCallRecord): string {
  if (call.cache === "miss") return "live";
  const age = call.cacheAgeMs === null ? null : formatCacheAge(call.cacheAgeMs);
  if (call.cache === "stale") return age ? `stale cache ${age}` : "stale cache";
  return age ? `cached ${age}` : "cached";
}

function receiptsOf(calls: readonly QlooCallRecord[], evidence: readonly Evidence[]): DesReceipt[] {
  const purposeByCall = new Map<string, string>();
  for (const e of evidence) for (const id of e.qlooCallIds) if (!purposeByCall.has(id)) purposeByCall.set(id, e.purpose);
  return calls.map((call, i) => ({
    n: i + 1,
    endpoint: call.path,
    filterLabel: filterLabel(call.filterType),
    purpose: purposeByCall.get(call.qlooCallId) ?? (call.path === "/search" ? "Resolution: exact name and type" : null),
    cache: call.cache,
    cacheLabel: cacheLabel(call),
    rows: call.rows,
    ms: Math.max(0, Math.round(call.ms)),
    requestId: call.requestId,
    error: call.error,
  }));
}

// Figures ----------------------------------------------------------------------------------------------

interface Index {
  evidence: ReadonlyMap<string, Evidence>;
  datasets: ReadonlyMap<string, DatasetEnvelope>;
  receiptByCall: ReadonlyMap<string, number>;
}

function sourceOf(index: Index, evidence: readonly Evidence[]): DesSource {
  const line = sourceFromEvidence(evidence);
  const firstCall = evidence[0]?.qlooCallIds[0];
  return { text: line.text, requestId: line.requestId, receipt: firstCall === undefined ? null : (index.receiptByCall.get(firstCall) ?? null) };
}

const evidenceOf = (index: Index, ids: readonly string[]): Evidence[] =>
  ids.flatMap((id) => {
    const e = index.evidence.get(id);
    return e ? [e] : [];
  });

/** "Strongest at 30–34, weakest at 55+": the extremes of the age indices, read from the bars. */
function dnaTitle(dataset: Extract<DatasetEnvelope, { kind: "Bars" }>, name: string): string {
  const ages = dataset.payload.groups.find((g) => g.key === "age")?.bars ?? [];
  const measured = ages.flatMap((b) => {
    const value = b.values[0]?.value ?? null;
    return value === null ? [] : [{ label: b.label, value }];
  });
  if (measured.length < 2) return `Audience DNA of ${name}`;
  const top = measured.reduce((a, b) => (b.value > a.value ? b : a));
  const low = measured.reduce((a, b) => (b.value < a.value ? b : a));
  return top.value > 0 ? `Strongest at ${top.label}, weakest at ${low.label}` : `No age group leans above average; weakest at ${low.label}`;
}

function dnaFigures(index: Index, result: SkillResult, name: string): DesFigure[] {
  return result.datasetIds.flatMap((id): DesFigure[] => {
    const dataset = index.datasets.get(id);
    if (!dataset) return [];
    const source = sourceOf(index, evidenceOf(index, dataset.evidenceIds));
    if (dataset.kind === "Bars") {
      return [
        {
          key: id,
          title: dnaTitle(dataset, name),
          caption: "Age and gender affinity indices against the average audience (0), group-level only.",
          dataset,
          source,
          display: "exhibit",
        },
      ];
    }
    // The facet tag list (audience_dna's Ranked dataset): its peer column counts nothing for one entity.
    if (dataset.kind === "Ranked" && dataset.payload.groups.some((g) => g.rows.length > 0)) {
      return [
        {
          key: id,
          title: "How Qloo describes it",
          caption: "Qloo's own tags for the entity, by family: qualitative descriptors, not survey answers.",
          dataset,
          source,
          display: "tags",
        },
      ];
    }
    return [];
  });
}

/** The evidence behind one domain's list: the bundle whose request asked for that entity type. */
function domainEvidence(index: Index, ids: readonly string[], domain: string): Evidence[] {
  const parsed = EntityType.safeParse(domain);
  const urn = parsed.success ? entityTypeUrn(parsed.data) : null;
  return evidenceOf(index, ids).filter((e) => e.provenance.requests.some((r) => r.query["filter.type"] === urn));
}

/** Rows each domain list shows: the head of the list keeps the tearsheet to one page. */
export const NEIGHBOUR_ROWS = 8;

/**
 * One figure per domain list, so each list cites its own request and lays out on its own (2 × 2, one
 * column on phones), cut to its top NEIGHBOUR_ROWS rows.
 */
function neighbourFigures(index: Index, result: SkillResult): DesFigure[] {
  return result.datasetIds.flatMap((id): DesFigure[] => {
    const dataset = index.datasets.get(id);
    if (!dataset || dataset.kind !== "Ranked") return [];
    return dataset.payload.groups
      .filter((g) => g.rows.length > 0)
      .map((group) => {
        const evidence = domainEvidence(index, dataset.evidenceIds, group.key);
        const rows = group.rows.slice(0, NEIGHBOUR_ROWS);
        const caption =
          rows.length < group.rows.length ? `Top ${rows.length} of ${group.rows.length} by fit within this request.` : "Ranked by fit within this request.";
        return {
          key: `${id}:${group.key}`,
          title: group.label,
          caption,
          dataset: { ...dataset, title: group.label, payload: { ...dataset.payload, groups: [{ ...group, rows }], caption: null } },
          source: sourceOf(index, evidence.length > 0 ? evidence : evidenceOf(index, dataset.evidenceIds)),
          display: "exhibit" as const,
        };
      });
  });
}

function travelFigures(index: Index, result: SkillResult): DesFigure[] {
  return result.datasetIds.flatMap((id): DesFigure[] => {
    const dataset = index.datasets.get(id);
    if (!dataset || dataset.kind !== "Quadrant" || dataset.payload.points.length === 0) return [];
    const top = [...dataset.payload.points].sort((a, b) => b.y - a.y)[0];
    return [
      {
        key: id,
        title: top ? `Its taste travels furthest to ${top.label}` : "Where its taste travels",
        // The payload's fixed caption names the set (D17: "among Qloo's top-50 US destinations for this audience").
        // The title's destination is the one ringed point: a crowded corner can leave it without a label.
        caption: top
          ? `The ring marks ${top.label}, the closest fit. Fit against popularity, split at the medians of this set of destinations.`
          : "Fit against popularity, split at the medians of this set of destinations.",
        dataset,
        source: sourceOf(index, evidenceOf(index, dataset.evidenceIds)),
        display: "exhibit",
        featured: top ? [top.key] : [],
      },
    ];
  });
}

/**
 * The cultural neighbourhood's notes on a tearsheet: the desk's sentence on what neighbours are, and how
 * to read a fit. The skill's own bullets speak of seed tags and a popularity cap, neither of which a
 * tearsheet uses, and of explainability, which it does not draw.
 */
const NEIGHBOUR_NOTES: readonly string[] = [
  DESK_LIMITATIONS.audience[0] ?? "Cultural neighbours are what this audience's taste points to in Qloo's graph.",
  "A fit is a percentile within its own request: 1.00 heads that list and compares nothing across domains.",
];

/** The flag sentences of a section, most severe first, then its fixed method notes. */
function notesOf(skill: SkillId, flags: readonly Flag[]): string[] {
  const fixed = skill === "cross_domain" ? NEIGHBOUR_NOTES : SKILLS[skill].limitations(flags);
  return [...new Set([...orderFlags(flags).map((f) => flagText(f)), ...fixed])];
}

function sectionOf(index: Index, id: DesSectionId, run: SectionRun, name: string): DesSection {
  if (run.kind === "failed") return { status: "failed", figures: [], notes: notesOf(run.skill, []), gap: FAILED_GAP };
  const { result } = run;
  const figures =
    id === "dna" ? dnaFigures(index, result, name) : id === "neighbours" ? neighbourFigures(index, result) : travelFigures(index, result);
  const notes = notesOf(run.skill, result.flags);
  const truncated = result.flags.includes("BUDGET_TRUNCATED");
  if (result.status === "error") return { status: "failed", figures, notes, gap: FAILED_GAP };
  if (figures.length === 0 || result.status === "empty") return { status: "empty", figures, notes, gap: truncated ? TRUNCATED_GAP : EMPTY_GAP[id] };
  if (result.status !== "partial") return { status: "ok", figures, notes, gap: null };
  return { status: "partial", figures, notes, gap: truncated ? `Part of it was not requested: ${TRUNCATED_REASON}.` : PARTIAL_GAP };
}

// Key figures -------------------------------------------------------------------------------------------

function receiptOfMetric(index: Index, metric: Metric): number | null {
  for (const id of metric.evidenceIds) {
    const call = index.evidence.get(id)?.qlooCallIds[0];
    const n = call === undefined ? undefined : index.receiptByCall.get(call);
    if (n !== undefined) return n;
  }
  return null;
}

function keyFigure(index: Index, metric: Metric, label: string, detail: string): DesKeyFigure {
  return {
    key: metric.id,
    label,
    value: metric.value === null ? NOT_MEASURED : metric.display,
    kind: "number",
    detail,
    badge: metric.badge,
    receipt: receiptOfMetric(index, metric),
  };
}

const TYPE_NOUN: Readonly<Record<DesType, string>> = {
  brand: "brands",
  artist: "artists",
  person: "public figures",
  podcast: "podcasts",
  tv_show: "TV shows",
  movie: "films",
};

function keyFiguresOf(index: Index, input: SheetInput, metrics: readonly Metric[], travel: DesSection): DesKeyFigure[] {
  const out: DesKeyFigure[] = [];
  if (input.popularity) {
    out.push(keyFigure(index, input.popularity, "Popularity", `Qloo's 0–1 reach score, across ${TYPE_NOUN[input.entity.type]} and beyond`));
  }
  const youth = metrics.find((m) => m.key === "dna.youth_index");
  if (youth) out.push(keyFigure(index, youth, "Youth index", "Young age groups minus old, 0 = even"));
  const women = metrics.find((m) => m.key === "dna.gender_index" && /\bwomen\b/i.test(m.label));
  if (women) out.push(keyFigure(index, women, "Women", "Gender index, 0 = average audience"));
  const quadrant = travel.figures[0]?.dataset;
  if (quadrant?.kind === "Quadrant") {
    const top = [...quadrant.payload.points].sort((a, b) => b.y - a.y)[0];
    const metric = top ? metrics.find((m) => m.key === "trvl.fit" && m.subjectRefs.includes(top.key)) : undefined;
    if (top && metric) {
      out.push({
        ...keyFigure(index, metric, "Top travel-taste fit", `${quadrant.payload.quadrantLabels[top.quadrant]} · of Qloo's top 50 US destinations`),
        value: top.label,
        kind: "name",
      });
    }
  }
  return out;
}

/** A number is traced when it cites evidence and every bundle it cites carries a request id. */
function tracedOf(metrics: readonly Metric[], evidence: ReadonlyMap<string, Evidence>): { traced: number; total: number } {
  const numbers = metrics.filter((m) => m.value !== null);
  const traced = numbers.filter(
    (m) => m.evidenceIds.length > 0 && m.evidenceIds.every((id) => (evidence.get(id)?.requestIds.length ?? 0) > 0),
  ).length;
  return { traced, total: numbers.length };
}

export function buildTearsheet(input: SheetInput): Tearsheet {
  const { snapshot, calls } = input;
  const index: Index = {
    evidence: new Map(snapshot.evidence.map((e) => [e.id, e])),
    datasets: new Map(snapshot.datasets.map((d) => [d.id, d])),
    receiptByCall: new Map(calls.map((c, i) => [c.qlooCallId, i + 1])),
  };
  const name = input.entity.name;
  const sections: Record<DesSectionId, DesSection> = {
    dna: sectionOf(index, "dna", input.sections.dna, name),
    neighbours: sectionOf(index, "neighbours", input.sections.neighbours, name),
    travel: sectionOf(index, "travel", input.sections.travel, name),
  };
  return {
    query: input.query,
    entity: input.entity,
    picked: input.picked,
    mnemonic: desMnemonic(input.query),
    computedAt: input.computedAt,
    keyFigures: keyFiguresOf(index, input, snapshot.metrics, sections.travel),
    sections,
    receipts: receiptsOf(calls, snapshot.evidence),
    traced: tracedOf(snapshot.metrics, index.evidence),
    requests: { total: calls.length, cached: calls.filter((c) => c.cache !== "miss").length },
  };
}


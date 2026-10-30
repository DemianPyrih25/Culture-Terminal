import { CONFIDENCE_CAP, confidenceBand, type DatasetEnvelope, type Metric, type Report } from "@ct/contracts";
import { ENTITY_ID_RE, SCRUB_KEEP_KEYS } from "@ct/qloo";
import { isNoiseTag } from "@ct/quant";
import type { LedgerSnapshot } from "../ledger";
import { citedIds } from "../tokens";

/**
 * The answer-quality audit (docs/ANSWER_QUALITY.md, automated checks; PLAN §6): code reads the finished
 * Report and the run's ledger and lists every problem the owner's list names that code can see. A clean
 * run has none. Assemble stores the list in Report.audit, run-agent prints it, and the per-job quality test
 * fails on any entry, so a regression shows in CI rather than on a customer's page.
 *
 * Checks: no literal escape sequence (\uXXXX, \xXX) in any report string (§11); no name cut with an
 * ellipsis (§11); no noise tag in a tag list (§10); the confidence band within its caps and its score (§2,
 * §3, R1); no thin or category-level metric behind a HIGH lead (§3, R1, R2); every number traced (§4); the
 * disclosure first when a concept was not in the data or the question was read as its nearest job (§8); the
 * ZIP-area comparison row labelled approximate (§5); no Qloo entity id anywhere (R8).
 */

/** A literal escape the renderer would print as text: a backslash-u with four hex digits, or backslash-x with two. */
const LITERAL_ESCAPE = /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/;
/** One entity id, for a test (ENTITY_ID_RE is global). */
const ENTITY_ID = new RegExp(ENTITY_ID_RE.source, "i");
/** Keys whose string values name something a card shows whole. */
const NAME_KEYS: ReadonlySet<string> = new Set(["name", "label", "brand", "title"]);
/** A ZIP-area comparison row ("Austin ZIP areas (whole ZIPs)", "ZIP areas touching Austin"). */
const ZIP_ROW = /\bZIP areas\b/i;

/** Every string in a JSON value with the key it sits under (null at the top or in a plain array). */
function* strings(value: unknown, key: string | null = null): Generator<{ key: string | null; text: string }> {
  if (typeof value === "string") yield { key, text: value };
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, key);
  else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) yield* strings(v, k);
}

/** Every tag a dataset payload lists: the items of an array under a key ending in "tags" (strings or { name }). */
function* tags(value: unknown, key: string | null = null): Generator<string> {
  if (Array.isArray(value)) {
    const tagList = key !== null && /tags$/i.test(key);
    for (const v of value) {
      if (tagList && typeof v === "string") yield v;
      else if (tagList && typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string") yield (v as { name: string }).name;
      else yield* tags(v, key);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) yield* tags(v, k);
  }
}

const shown = (s: string): string => (s.length <= 60 ? s : `${s.slice(0, 57)}...`);

export function auditReport(report: Report, ledger: Pick<LedgerSnapshot, "metrics" | "datasets" | "evidence">): string[] {
  const out: string[] = [];
  const metric = new Map(ledger.metrics.map((m) => [m.id, m]));
  const shownDatasets = new Set(report.exhibits.map((e) => e.datasetId));
  const datasets: DatasetEnvelope[] = ledger.datasets.filter((d) => shownDatasets.has(d.id));

  // §11: literal escapes anywhere in the report, and in the datasets its exhibits draw.
  for (const { text } of strings(report)) if (LITERAL_ESCAPE.test(text)) out.push(`Literal escape sequence in report text: "${shown(text)}".`);
  for (const d of datasets) for (const { text } of strings(d.payload)) if (LITERAL_ESCAPE.test(text)) out.push(`Literal escape sequence in ${d.id}: "${shown(text)}".`);

  // §11: a name cut with an ellipsis.
  for (const d of datasets) {
    for (const { key, text } of strings(d.payload)) if (key !== null && NAME_KEYS.has(key) && text.includes("…")) out.push(`Name cut with an ellipsis in ${d.id}: "${shown(text)}".`);
  }
  for (const k of report.kpis) if (k.label.includes("…")) out.push(`KPI label cut with an ellipsis: "${shown(k.label)}".`);

  // §10: noise tags in a tag list.
  for (const d of datasets) {
    const noise = [...new Set([...tags(d.payload)].filter((name) => isNoiseTag({ name })))];
    if (noise.length > 0) out.push(`Noise tags in ${d.id}: ${noise.slice(0, 5).map((t) => `"${t}"`).join(", ")}.`);
  }

  // §2, §3, R1: the band follows the score, and the score keeps every fired cap.
  const { confidence } = report.verdict;
  if (confidence.band !== confidenceBand(confidence.score)) out.push(`Confidence band ${confidence.band} does not match its score ${confidence.score}.`);
  for (const line of confidence.breakdown) {
    const cap = line.cap ?? CONFIDENCE_CAP[line.rule];
    if (cap !== undefined && confidence.score > cap) out.push(`Confidence ${confidence.score} is above the ${line.rule} cap of ${cap}.`);
  }

  // R1, R2: a HIGH lead never rests on a thin sample or a category-level read.
  if (confidence.band === "HIGH") {
    const lead = citedIds("M", [], [report.verdict.headline, report.verdict.thesis]).flatMap((id) => metric.get(id) ?? []);
    const weak = lead.filter((m: Metric) => m.thin === true || m.conceptRead === "category" || m.conceptRead === "proxy");
    if (weak.length > 0) out.push(`HIGH confidence over a thin or category-level lead: ${weak.map((m) => m.id).join(", ")}.`);
  }

  // §4: every number shown is traced.
  const { traced, total } = report.receipt.numbersTraced;
  if (traced !== total) out.push(`Numbers traced ${traced} of ${total}: every number shown must trace to its request.`);

  // §8: the disclosure comes first.
  const flagged = (flag: string) => report.limitations.findIndex((l) => l.source === "flag" && l.flag === flag);
  const concept = flagged("CONCEPT_NOT_IN_DATA");
  if (concept > 0) out.push("The concept-not-in-data limitation is not the first limitation.");
  if (concept >= 0) {
    const text = report.limitations[concept]!.text;
    if (!report.verdict.thesis.startsWith(text)) out.push("The thesis does not open with the concept disclosure.");
  }
  const readAs = flagged("READ_AS_NEAREST_JOB");
  if (readAs > (concept >= 0 ? 1 : 0)) out.push("The nearest-job limitation is not at the top of the limitations.");

  // §5: the ZIP-area comparison row says it is approximate.
  const zipLabels = [
    ...ledger.metrics.filter((m) => ZIP_ROW.test(m.label)).map((m) => m.label),
    ...datasets.flatMap((d) => [...strings(d.payload)].filter(({ key, text }) => key !== null && NAME_KEYS.has(key) && ZIP_ROW.test(text)).map((s) => s.text)),
  ];
  for (const label of new Set(zipLabels)) if (!/approximate/i.test(label)) out.push(`ZIP-area row not labelled approximate: "${shown(label)}".`);

  // R8: no Qloo entity id in anything the browser receives (run ids and request ids are not entity ids).
  if ([...strings(report)].some(({ key, text }) => (key === null || !SCRUB_KEEP_KEYS.has(key)) && ENTITY_ID.test(text))) {
    out.push("A Qloo entity id appears in the report.");
  }

  return [...new Set(out)];
}

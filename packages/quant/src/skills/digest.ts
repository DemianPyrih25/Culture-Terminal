import {
  DATA_NOTICE,
  digestFits,
  Flag,
  MODEL_DIGEST_MAX_ROWS,
  type DatasetId,
  type DigestRow,
  type EvidenceId,
  type Finding,
  type Metric,
  type ModelDigest,
  type RegisteredEntity,
  type RegisteredTag,
  type SkillResult,
  type SkillStatus,
  type StepId,
  type ToolName,
} from "@ct/contracts";
import { safeName, safeText } from "./format";

/**
 * The uniform tool result (PLAN §4.3): every skill assembles its ledger output into DigestParts and
 * gets back a SkillResult whose digest is guaranteed to fit MODEL_DIGEST_MAX_TOKENS once wrapped.
 */

export interface DigestParts {
  status: SkillStatus;
  evidenceIds: readonly EvidenceId[];
  datasetIds: readonly DatasetId[];
  metrics: readonly Metric[];
  rows: readonly DigestRow[];
  findings: readonly Finding[];
  flags: Iterable<Flag>;
  /** Entities and tags this call added to the registry (not ones it found already registered). */
  registered: readonly (RegisteredEntity | RegisteredTag)[];
  notices: readonly string[];
}

/** The wrapper attributes a digest is measured against (wrapQlooData). */
export interface DigestTarget {
  tool: ToolName;
  step: StepId | null;
}

/** Deduplicated, in Flag enum order, so the same run always produces the same digest bytes. */
export function orderedFlags(flags: Iterable<Flag>): Flag[] {
  const set = new Set(flags);
  return Flag.options.filter((f) => set.has(f));
}

export function buildSkillDigest(parts: DigestParts): ModelDigest {
  return {
    _data_notice: DATA_NOTICE,
    status: parts.status,
    evidence_ids: [...parts.evidenceIds],
    dataset_ids: [...parts.datasetIds],
    metrics: parts.metrics.map((m) => ({ id: m.id, label: m.label, display: m.display, badge: m.badge })),
    top_rows: parts.rows.slice(0, MODEL_DIGEST_MAX_ROWS),
    findings: parts.findings.map((f) => ({ id: f.id, kind: f.kind, text: f.text, suggestion: f.suggestion })),
    flags: orderedFlags(parts.flags),
    registered: parts.registered.map((e) => ({ ref: e.ref, name: safeName(e.name), type: e.type })),
    notices: [...parts.notices],
  };
}

/** Last-resort lengths for model-facing texts, used only when a digest cannot fit otherwise. */
const SHORT_LABEL = 60;
const SHORT_TEXT = 160;
const SHORT_NAME = 24;

/** Tells the model rows were cut and where the full table is, so a short list never reads as complete. */
function rowsOmittedNotice(omitted: number, total: number, datasetIds: readonly DatasetId[]): string {
  const where = datasetIds.length > 0 ? `; the full table is in ${datasetIds.join(", ")}` : "";
  return `${omitted} of ${total} rows left out to fit this result${where}.`;
}

function shortened(digest: ModelDigest): ModelDigest {
  return {
    ...digest,
    metrics: digest.metrics.map((m) => ({ ...m, label: safeText(m.label, SHORT_LABEL) })),
    findings: digest.findings.map((f) => ({ ...f, text: safeText(f.text, SHORT_TEXT) })),
    registered: digest.registered.map((e) => ({ ...e, name: safeText(e.name, SHORT_NAME) })),
  };
}

/**
 * Trims a digest until it fits. Rows go first (the full table is in the dataset), replaced by a
 * notice that says how many; then notices from the end; then metric labels, finding texts and
 * registered names are shortened. Ids, metrics and findings are never dropped, because the model can
 * only cite what it was given. `totalRows` also counts rows the row cap already cut. Throws only when
 * even the shortened digest cannot fit, which the per-skill caps on metrics and findings rule out.
 */
export function fitSkillDigest(digest: ModelDigest, target: DigestTarget, totalRows = digest.top_rows.length): ModelDigest {
  let base = digest;
  let rows = digest.top_rows.length;
  let notices = digest.notices.length;
  const build = (): ModelDigest => {
    const omitted = totalRows - rows;
    const kept = digest.notices.slice(0, notices);
    return {
      ...base,
      top_rows: digest.top_rows.slice(0, rows),
      notices: omitted > 0 ? [rowsOmittedNotice(omitted, totalRows, digest.dataset_ids), ...kept] : kept,
    };
  };
  let out = build();
  while (!digestFits(out, target)) {
    if (rows > 0) rows -= 1;
    else if (notices > 0) notices -= 1;
    else if (base === digest) base = shortened(digest);
    else throw new Error(`${target.tool}: digest exceeds the token budget even without rows and notices`);
    out = build();
  }
  return out;
}

export function skillResult(parts: DigestParts, target: DigestTarget): SkillResult {
  const forModel = fitSkillDigest(buildSkillDigest(parts), target, parts.rows.length);
  return {
    forModel,
    evidenceIds: [...parts.evidenceIds],
    metricIds: parts.metrics.map((m) => m.id),
    datasetIds: [...parts.datasetIds],
    findingIds: parts.findings.map((f) => f.id),
    flags: [...forModel.flags],
    status: parts.status,
  };
}

/** A result for a call that could not run at all: no calls, nothing in the ledger, one notice saying why. */
export function skillErrorResult(target: DigestTarget, message: string): SkillResult {
  return skillResult(
    {
      status: "error",
      evidenceIds: [],
      datasetIds: [],
      metrics: [],
      rows: [],
      findings: [],
      flags: [],
      registered: [],
      notices: [message],
    },
    target,
  );
}

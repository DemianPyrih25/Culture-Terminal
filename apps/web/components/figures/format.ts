import type { Comparator, MetricUnit, NoValueReason } from "@ct/contracts";
import { stepDigits } from "./scale";

/**
 * Number and label formatting shared by the figure families. Figures print what
 * the dataset holds and never invent a value: a missing cell prints its reason, never 0.
 */

/** The typographic minus the brief uses for negatives ("−0.21"). */
export const MINUS = "−";

/** How a figure prints numbers. */
export interface NumberStyle {
  /** Fraction digits; rank and count default to 0, everything else to 2. */
  digits?: number;
  /** false prints ".56" instead of "0.56" for values between −1 and 1 (the dense plots). Default true. */
  leadingZero?: boolean;
  /** Print "+" before positive values. Defaults to true for delta units. */
  signed?: boolean;
}

const ZERO_DIGIT_UNITS: ReadonlySet<MetricUnit> = new Set(["rank", "count"]);

/** A number as a figure prints it, e.g. ".56", "1.34", "+0.18", "−0.21". */
export function formatNumber(value: number, unit: MetricUnit, style: NumberStyle = {}): string {
  const digits = style.digits ?? (ZERO_DIGIT_UNITS.has(unit) ? 0 : 2);
  const signed = style.signed ?? unit === "delta";
  let body = Math.abs(value).toFixed(digits);
  const isZero = Number(body) === 0;
  if (style.leadingZero === false && body.startsWith("0.")) body = body.slice(1);
  if (isZero) return body;
  if (value < 0) return `${MINUS}${body}`;
  return signed ? `+${body}` : body;
}

/** An axis tick: "0" at zero, otherwise as many digits as the step needs ("0.2", ".05", "1.10"). */
export function formatTick(
  value: number,
  step: number,
  unit: MetricUnit,
  opts: { leadingZero?: boolean; absolute?: boolean; minDigits?: number } = {},
): string {
  if (Math.abs(value) < 1e-9) return "0";
  const digits = Math.max(stepDigits(step), opts.minDigits ?? 0);
  return formatNumber(opts.absolute ? Math.abs(value) : value, unit, {
    digits,
    signed: false,
    leadingZero: opts.leadingZero,
  });
}

/** Why a value is missing, in the words a reader sees. */
export const REASON_LABEL: Readonly<Record<NoValueReason, string>> = {
  not_scored: "not scored",
  dropped: "dropped by Qloo",
  not_measured: "not measured",
  no_signal: "no signal",
  unavailable: "unavailable",
  quality_gate: "below the quality gate",
  budget_truncated: "not fetched (budget)",
  insufficient_n: "too few cells",
  coarse: "location too coarse",
  self: "same entity",
  error: "request failed",
};

/** The reason text for a missing value; a missing reason still reads as "not measured". */
export function reasonLabel(reason: NoValueReason | null): string {
  return reason === null ? REASON_LABEL.not_measured : REASON_LABEL[reason];
}

/** A value or its explained absence, ready for a table cell. */
export type CellText = { kind: "value"; text: string } | { kind: "missing"; reason: string };

export function cellText(
  cell: { value: number | null; reason: NoValueReason | null },
  unit: MetricUnit,
  style: NumberStyle = {},
): CellText {
  return cell.value === null
    ? { kind: "missing", reason: reasonLabel(cell.reason) }
    : { kind: "value", text: formatNumber(cell.value, unit, style) };
}

/** The comparator a delta is measured against, as a column head: "Δ vs city". */
export function comparatorHead(comparator: Comparator): string {
  return `Δ vs ${COMPARATOR_NOUN[comparator]}`;
}

/** The comparator as a short noun for heads and direction labels: "city", "peers", "baseline", "even split". */
export const COMPARATOR_NOUN: Readonly<Record<Comparator, string>> = {
  CITY: "city",
  PEERS: "peers",
  BASELINE: "baseline",
  WITHIN_CALL: "even split",
};

/** What a value is read against, for table heads: "Fit (within call)", "Index (vs baseline)". */
export const COMPARATOR_PHRASE: Readonly<Record<Comparator, string>> = {
  CITY: "vs city",
  PEERS: "vs peers",
  BASELINE: "vs baseline",
  WITHIN_CALL: "within call",
};

/** A request id shortened for source lines and sidenotes: "0001…f001". Short ids pass through. */
export function abbreviateRequestId(requestId: string): string {
  return requestId.length > 10 ? `${requestId.slice(0, 4)}…${requestId.slice(-4)}` : requestId;
}

/**
 * Short uppercase codes for axis items, unique within the list: initials for several words
 * ("Brand Alpha" → "BA"), the first three letters for one ("Juniper" → "JUN"). `overrides` wins.
 */
export function axisCodes(
  items: readonly { key: string; label: string }[],
  overrides: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const item of items) {
    const forced = overrides[item.key];
    const candidates = forced ? [forced] : codeCandidates(item.label);
    let code = candidates.find((c) => c.length > 0 && !used.has(c)) ?? candidates[0] ?? "?";
    for (let n = 2; used.has(code); n += 1) code = `${candidates[0] ?? "?"}${n}`;
    used.add(code);
    out.set(item.key, code);
  }
  return out;
}

function codeCandidates(label: string): string[] {
  const words = label
    .split(/[\s\-–—/&·]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length > 0);
  if (words.length === 0) return ["?"];
  const upper = (s: string) => s.toUpperCase();
  if (words.length === 1) {
    const w = words[0]!;
    return [upper(w.slice(0, 3)), upper(w.slice(0, 4)), upper(w.slice(0, 2) + w.slice(-1))];
  }
  const initials = upper(words.slice(0, 3).map((w) => w[0]).join(""));
  const first = words[0]!;
  const last = words[words.length - 1]!;
  return [initials, upper(first.slice(0, 2) + last[0]), upper(first[0] + last.slice(0, 2))];
}

/**
 * A label in sentence case for the chart scale: each " · " part written all in capitals is lowered,
 * then the first letter is raised ("UNDER-THE-RADAR FIT · no pricing data" reads "Under-the-radar fit ·
 * no pricing data"). Mixed-case parts keep their capitals, so names stay as written.
 */
export function sentenceCase(label: string): string {
  const parts = label.split(" · ").map((part) => (/[a-z]/.test(part) || !/[A-Z]{2}/.test(part) ? part : part.toLowerCase()));
  const out = parts.join(" · ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

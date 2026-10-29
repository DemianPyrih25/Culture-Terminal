import type { Metric } from "@ct/contracts";

/**
 * Plain words for the analyst shorthand that reaches a reader (ANSWER_QUALITY §1, Q1): QUANT's metric
 * displays and labels ("+42 · NEW", "6 of 20 in the area top 20", "SOUND music tag", "0.62 · Latent & open")
 * and the same words when the ANALYST copies them into prose ("(DERIVED)", "EMPTY_RESULT", "τ", "p").
 * Applied at display time, so runs stored before the fix read the same. Numbers are never changed:
 * only the words around them. Badges stay where the figure contract shows them (a chip, the inspector).
 */

/** The white-space quadrants (geo_lift), in a reader's words. */
const QUADRANT_PLAIN: Readonly<Record<string, string>> = {
  "Latent & open": "strong interest, few rivals",
  "Proven & crowded": "strong interest, many rivals",
  Saturated: "many rivals, weaker interest",
  Cold: "weak interest, few rivals",
};

/** One " · " piece of a metric display in plain words; any other piece is unchanged. */
export function plainPiece(piece: string): string {
  if (piece === "NEW") return "new here";
  if (piece === "not ranked here") return "not in the top tags here";
  const quadrant = QUADRANT_PLAIN[piece];
  if (quadrant !== undefined) return quadrant;
  // Block DNA's NEW count, for an area or a whole city: "6 of 20 in the area top 20".
  const fresh = /^(\d+) of (\d+) in the area (?:music )?top \d+$/.exec(piece);
  if (fresh) return `${fresh[1]} of the top ${fresh[2]} tags new here`;
  return piece;
}

/** A metric's display in plain words: "+42 · NEW" → "+42 · new here". */
export function plainDisplay(metric: Pick<Metric, "display">): string {
  return metric.display
    .split(" · ")
    .map((p) => plainPiece(p.trim()))
    .join(" · ");
}

/** Word rewrites shared by metric labels and prose. Order matters: the longer phrases first. */
const PLAIN_WORDS: readonly (readonly [RegExp, string])[] = [
  // A badge in parentheses after a number reads as code; the chip and the inspector carry it.
  [/\s*\((?:MEASURED|DERIVED|ESTIMATED|STALE|UNAVAILABLE)\)/g, ""],
  [/\bEMPTY_RESULT\b/g, "no results"],
  // Block DNA families: "WHO venue-goer taste tag", "VIBE tag", "WHAT tag", "SOUND music tag".
  [/\bWHO (?=venue-goer)/g, ""],
  [/\bSOUND (?=music)/g, ""],
  [/\bSOUND\b/g, "music"],
  [/\bVIBE\b/g, "vibe"],
  [/\bWHAT (?=tags?\b)/g, "place-type "],
  [/\bWHO (?=tags?\b)/g, "venue-goer "],
  [/\bNEW (?=(?:music |vibe |place-type |venue-goer )?(?:taste )?tags?\b)/g, "new "],
  [/\bLatent & open\b/g, "strong interest, few rivals"],
  [/\bProven & crowded\b/g, "strong interest, many rivals"],
  [/\bMann–Kendall τ/g, "trend strength (Mann–Kendall τ)"],
  [/\bMann–Kendall p\b/g, "trend p-value (Mann–Kendall)"],
];

/** Words in plain English; the first letter keeps its case. */
export function plainWords(text: string): string {
  let out = text;
  for (const [re, to] of PLAIN_WORDS) out = out.replace(re, to);
  if (out !== text && /^[A-Z]/.test(text) && /^[a-z]/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/**
 * The words right before a momentum token in prose: "τ {{M4}}" reads "trend strength +0.87" and
 * "p {{M5}}" reads "p-value <0.001". Text before any other token is unchanged.
 */
export function plainBeforeMetric(text: string, metric: Pick<Metric, "key">): string {
  if (metric.key === "mom.mann_kendall_tau") return text.replace(/(^|[\s(])τ(\s*=?\s*)$/, "$1trend strength ");
  if (metric.key === "mom.mann_kendall_p") return text.replace(/(^|[\s(])p(\s*=?\s*)$/, "$1p-value ");
  return text;
}

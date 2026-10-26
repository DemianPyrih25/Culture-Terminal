import { CONFIDENCE_PENALTY, ConfidenceBand, confidenceBand, type ConfidenceRule } from "@ct/contracts";

/** Pure helpers that turn code constants into the reference pages' words. */

/** "claude-haiku-5-5" → "Haiku 5.5"; any other id is returned as it is. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!m) return model;
  const [, family = "", major, minor] = m;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** "/v2/insights" → "Insights", "/search" → "Search". */
export function endpointLabel(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1) ?? path;
  return `${last.charAt(0).toUpperCase()}${last.slice(1)}`;
}

/** Each conviction band's score range, read off confidenceBand itself: HIGH 75–100, MED 50–74, LOW 0–49. */
export function bandRanges(): { band: ConfidenceBand; min: number; max: number }[] {
  const ranges = new Map<ConfidenceBand, { min: number; max: number }>();
  for (let score = 0; score <= 100; score += 1) {
    const band = confidenceBand(score);
    const range = ranges.get(band);
    if (range) range.max = score;
    else ranges.set(band, { min: score, max: score });
  }
  return ConfidenceBand.options.flatMap((band) => {
    const range = ranges.get(band);
    return range ? [{ band, ...range }] : [];
  });
}

/** The points one occurrence of a rule costs, as printed: "−15". */
export function penaltyText(rule: ConfidenceRule): string {
  return `−${CONFIDENCE_PENALTY[rule]}`;
}

/** The month a trending window ends, e.g. "Sep 2025", from its ISO end date. */
export function windowEndMonth(end: string): string {
  const d = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return end;
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

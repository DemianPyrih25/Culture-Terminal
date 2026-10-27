/**
 * Audience DNA in words (G-R2): which way an audience leans on age and gender, and the age span where it
 * over-indexes. Indices run from −1 to 1 around the average audience (0); within ±LEAN_THRESHOLD reads as even.
 * Shared by the answer page (N12) and the profile page (N14).
 */

export const LEAN_THRESHOLD = 0.05;

/** "+0.31", "−0.12" (a true minus sign), "0.00". */
export function signed(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits);
  return value > 0 ? `+${text}` : `−${text}`;
}

/** Age lean from a youth index: positive leans younger. */
export function ageLeanWord(youth: number | null): string | null {
  if (youth === null || !Number.isFinite(youth)) return null;
  if (youth > LEAN_THRESHOLD) return "Leans younger";
  if (youth < -LEAN_THRESHOLD) return "Leans older";
  return "Even on age";
}

/** Gender lean from an index for women vs the average audience: positive leans female. */
export function genderLeanWord(female: number | null): string | null {
  if (female === null || !Number.isFinite(female)) return null;
  if (female > LEAN_THRESHOLD) return "Leans female";
  if (female < -LEAN_THRESHOLD) return "Leans male";
  return "Even gender mix";
}

export interface AgeBand {
  label: string;
  value: number | null;
}

/** The band with the highest index above the threshold, or null when none leans in. */
export function peakAge(bands: readonly AgeBand[]): AgeBand | null {
  let best: AgeBand | null = null;
  for (const band of bands) {
    if (band.value === null || band.value <= LEAN_THRESHOLD) continue;
    if (best === null || (best.value ?? -Infinity) < band.value) best = band;
  }
  return best;
}

/** "25–29" → [25, 29]; "≤24" → [null, 24]; "55+" → [55, null]; anything else null. */
function bandEnds(label: string): [number | null, number | null] | null {
  const text = label.replace(/\s/g, "");
  let m = /^(\d+)[–-](\d+)$/.exec(text);
  if (m) return [Number(m[1]), Number(m[2])];
  m = /^(?:≤|<=|under)(\d+)$/i.exec(text);
  if (m) return [null, Number(m[1])];
  m = /^(\d+)\+$/.exec(text);
  if (m) return [Number(m[1]), null];
  return null;
}

/**
 * The longest run of adjacent bands over the threshold that holds the peak, merged into one span: 25–29 and
 * 30–34 read "25–34"; a span that runs to the open top band reads "35+". Null when no band leans in.
 */
export function positiveAgeSpan(bands: readonly AgeBand[]): string | null {
  const peak = peakAge(bands);
  if (!peak) return null;
  const at = bands.indexOf(peak);
  let from = at;
  let to = at;
  const over = (i: number) => (bands[i]?.value ?? -Infinity) > LEAN_THRESHOLD;
  while (from > 0 && over(from - 1)) from -= 1;
  while (to < bands.length - 1 && over(to + 1)) to += 1;
  const first = bands[from] as AgeBand;
  const last = bands[to] as AgeBand;
  if (from === to) return first.label;
  const a = bandEnds(first.label);
  const b = bandEnds(last.label);
  if (!a || !b) return `${first.label} to ${last.label}`;
  if (a[0] === null) return b[1] === null ? first.label : `under ${b[1] + 1}`;
  if (b[1] === null) return `${a[0]}+`;
  return `${a[0]}–${b[1]}`;
}

/** "Fans lean female and 35–44.", "Fans lean younger.", or null when nothing leans. */
export function fansLeanTitle(gender: string | null, ageSpan: string | null): string | null {
  const g = gender && gender.startsWith("Leans ") ? gender.slice("Leans ".length) : null;
  if (g && ageSpan) return `Fans lean ${g} and ${ageSpan}.`;
  if (g) return `Fans lean ${g}.`;
  if (ageSpan) return `Fans peak at ${ageSpan}.`;
  return null;
}

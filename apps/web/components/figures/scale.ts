/**
 * Layout arithmetic for the hand-written SVG figures. Everything is pure and deterministic, so the
 * server and the browser draw the same pixels: no measuring, no randomness, no locale.
 */

/** Rounds a coordinate to 0.01 px so the markup stays short and stable. */
export function px(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A linear map from a domain to a pixel range. A zero-width domain maps everything to the range start. */
export function linear(domain: readonly [number, number], range: readonly [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** The 1-2-2.5-5 step closest to span/count. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

/** A domain widened to whole steps, with the step it was built from. */
export function niceDomain(min: number, max: number, count = 4): { min: number; max: number; step: number } {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return niceDomain(min - pad, max + pad, count);
  }
  const step = niceStep(max - min, count);
  return { min: fix(Math.floor(min / step + 1e-9) * step), max: fix(Math.ceil(max / step - 1e-9) * step), step };
}

/** Ticks from min to max at `step`, inclusive, free of floating-point noise. */
export function ticksBetween(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0)) return out;
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  for (let k = first; k <= last; k += 1) out.push(fix(k * step));
  return out;
}

/** A domain symmetric around `centre` that holds every value, in whole steps of a nice size. */
export function symmetricDomain(
  values: readonly number[],
  centre: number,
  count = 3,
): { min: number; max: number; step: number } {
  const reach = Math.max(0, ...values.map((v) => Math.abs(v - centre)));
  const step = niceStep(reach > 0 ? reach : 1, count);
  const half = Math.max(step, fix(Math.ceil(reach / step - 1e-9) * step));
  return { min: fix(centre - half), max: fix(centre + half), step };
}

function fix(v: number): number {
  return Number(v.toFixed(10));
}

/** Fraction digits a tick step needs: 0.2 → 1, 0.25 → 2, 5 → 0. */
export function stepDigits(step: number): number {
  for (let d = 0; d <= 6; d += 1) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  }
  return 6;
}

// Text --------------------------------------------------------------------------------------------

const NARROW = new Set([..."iIlj.,:;'!|()[]{}`1ft"]);
const WIDE = new Set([..."mwMW@%"]);

/**
 * Estimated advance width of Inter text in px. Good to a few percent for labels, which is all the
 * figures need to truncate a label or keep two labels from colliding.
 */
export function textWidth(text: string, fontSize: number, opts: { weight?: number; tracking?: number } = {}): number {
  let em = 0;
  for (const ch of text) {
    if (ch === " ") em += 0.28;
    else if (NARROW.has(ch)) em += 0.3;
    else if (WIDE.has(ch)) em += 0.85;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else em += 0.56;
  }
  const weight = opts.weight ?? 400;
  const bold = weight >= 600 ? 1.06 : weight >= 500 ? 1.03 : 1;
  return em * fontSize * bold + [...text].length * (opts.tracking ?? 0);
}

/** The text, cut with an ellipsis so it fits `maxWidth`. */
export function fitText(
  text: string,
  maxWidth: number,
  fontSize: number,
  opts: { weight?: number; tracking?: number } = {},
): string {
  if (textWidth(text, fontSize, opts) <= maxWidth) return text;
  const chars = [...text];
  for (let n = chars.length - 1; n > 0; n -= 1) {
    const cut = `${chars.slice(0, n).join("").trimEnd()}…`;
    if (textWidth(cut, fontSize, opts) <= maxWidth) return cut;
  }
  return "…";
}

// Hatching ----------------------------------------------------------------------------------------

/**
 * A path of 45° hatch lines clipped to a rectangle: the not-measured texture (A/No signal). Drawn
 * as explicit segments, so no pattern id is needed and two figures on a page never share state.
 */
export function hatchPath(x: number, y: number, w: number, h: number, step = 5): string {
  const parts: string[] = [];
  // Each line runs from bottom-left to top-right: local points (t, h) → (t + h, 0).
  for (let t = -h + step / 2; t < w; t += step) {
    let x0 = t;
    let y0 = h;
    let x1 = t + h;
    let y1 = 0;
    if (x0 < 0) {
      y0 = h + x0;
      x0 = 0;
    }
    if (x1 > w) {
      y1 = x1 - w;
      x1 = w;
    }
    if (x1 - x0 <= 0.01) continue;
    parts.push(`M${px(x + x0)} ${px(y + y0)}L${px(x + x1)} ${px(y + y1)}`);
  }
  return parts.join("");
}

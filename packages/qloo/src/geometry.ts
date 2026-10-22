/**
 * Location values: WKT (lon-first) for signal.location, and the `lat,lon` pair /search takes.
 * Canonical forms round coordinates to 5 dp (about a metre) and drop optional whitespace, the form
 * the probe sent live: `POLYGON((-86.9 36.05,-86.65 36.05,…))`.
 */

export type WktType = "POINT" | "POLYGON" | "MULTIPOLYGON";
export type LonLat = readonly [lon: number, lat: number];
type WktToken = "(" | ")" | "," | LonLat;

export interface ParsedWkt {
  type: WktType;
  coordinates: LonLat[];
  tokens: readonly WktToken[];
}

const COORD_DP = 5;
const NUMBER = String.raw`[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const COORDINATE_RE = new RegExp(`^(${NUMBER})\\s+(${NUMBER})$`);
const LAT_LON_RE = new RegExp(`^\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*$`);
const DEPTH: Readonly<Record<WktType, number>> = { POINT: 1, POLYGON: 2, MULTIPOLYGON: 3 };

/** A plain decimal string: no exponent, no trailing fractional zeros, no negative zero. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`formatNumber: ${n} is not finite`);
  if (n === 0) return "0";
  const s = String(n);
  return /e/i.test(s) ? expandExponent(s) : s;
}

function expandExponent(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) throw new RangeError(`formatNumber: cannot expand ${s}`);
  const [, sign = "", int = "", frac = "", exp = "0"] = m;
  const digits = int + frac;
  const point = int.length + Number(exp);
  let out =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return sign + out.replace(/^0+(?=\d)/, "");
}

export function roundCoordinate(x: number): number {
  const factor = 10 ** COORD_DP;
  return Math.round(x * factor) / factor;
}

const coordinateText = (x: number): string => formatNumber(roundCoordinate(x));

/** True when the value is meant as WKT (a word followed by a parenthesis). */
export function looksLikeWkt(value: string): boolean {
  return /^\s*[A-Za-z]+\s*\(/.test(value);
}

/** Parses POINT, POLYGON or MULTIPOLYGON with two-dimensional coordinates. Throws a plain Error naming the problem. */
export function parseWkt(value: string): ParsedWkt {
  const m = /^\s*([A-Za-z]+)\s*(\(.*\))\s*$/s.exec(value);
  const type = m?.[1]?.toUpperCase();
  if (!m || (type !== "POINT" && type !== "POLYGON" && type !== "MULTIPOLYGON")) {
    throw new Error("is not POINT, POLYGON or MULTIPOLYGON WKT");
  }
  const body = m[2] ?? "";
  const tokens: WktToken[] = [];
  const coordinates: LonLat[] = [];
  let depth = 0;
  let pending = "";
  const flush = (): void => {
    const text = pending.trim();
    pending = "";
    if (text === "") return;
    const c = COORDINATE_RE.exec(text);
    if (!c || depth !== DEPTH[type]) throw new Error(`has a malformed coordinate "${text.slice(0, 40)}"`);
    const pair: LonLat = [Number(c[1]), Number(c[2])];
    coordinates.push(pair);
    tokens.push(pair);
  };
  for (const ch of body) {
    if (ch === "(" || ch === ")" || ch === ",") {
      flush();
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth < 0) throw new Error("has unbalanced parentheses");
      tokens.push(ch);
    } else {
      pending += ch;
    }
  }
  flush();
  if (depth !== 0) throw new Error("has unbalanced parentheses");
  if (coordinates.length === 0) throw new Error("has no coordinates");
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const cur = tokens[i];
    if ((prev === "(" || prev === ",") && (cur === ")" || cur === ",")) throw new Error("has an empty coordinate");
  }
  return { type, coordinates, tokens };
}

/** The canonical text of parsed WKT: upper-case type, 5 dp coordinates, no optional whitespace. */
export function canonicalWkt(parsed: ParsedWkt): string {
  const body = parsed.tokens
    .map((t) => (typeof t === "string" ? t : `${coordinateText(t[0])} ${coordinateText(t[1])}`))
    .join("");
  return parsed.type + body;
}

/**
 * Why a WKT coordinate pair is wrong, or null. A pair whose first value sits in the US latitude
 * band and whose second sits in the US longitude band is a swapped `POINT(lat lon)`: as lon-first it
 * would be a point in Antarctica, which no caller means.
 */
export function lonLatProblem([lon, lat]: LonLat): string | null {
  if (lon >= 15 && lon <= 75 && lat >= -180 && lat <= -60) return "looks swapped (lat lon); WKT is lon-first";
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return "is out of range for lon lat";
  return null;
}

/** Parses a `lat,lon` pair (the /search filter.location form), or null when it is not one. */
export function parseLatLon(value: string): readonly [lat: number, lon: number] | null {
  const m = LAT_LON_RE.exec(value);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Why a `lat,lon` pair is wrong, or null; the mirror image of {@link lonLatProblem}. */
export function latLonProblem([lat, lon]: readonly [number, number]): string | null {
  if (lat >= -180 && lat <= -60 && lon >= 15 && lon <= 75) return "looks swapped (lon,lat); this form is lat,lon";
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return "is out of range for lat,lon";
  return null;
}

export function canonicalLatLon([lat, lon]: readonly [number, number]): string {
  return `${coordinateText(lat)},${coordinateText(lon)}`;
}

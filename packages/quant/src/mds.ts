/**
 * Classical (Torgerson) multidimensional scaling for the Category Taste Map (SPEC §5.3 S1, P1
 * extension): k ≤ 14 entities from the triangular similarity calls, placed in 2D so that map
 * distance approximates 1 − similarity. Pure and deterministic: the eigenvectors come from cyclic
 * Jacobi rotations in a fixed order, and each axis is oriented by the first point (the subject), so
 * the same matrix always draws the same map and a small change in it never mirrors the map.
 */

export interface MdsResult {
  /** n × dims coordinates, centred on the origin; distances approximate the input dissimilarities. */
  coords: number[][];
  /**
   * Every eigenvalue of the double-centred matrix B, largest first; float noise around 0 reads as 0,
   * and a negative one flags distances no Euclidean map can hold.
   */
  eigenvalues: number[];
  /**
   * Mardia's fit: the kept axes' positive eigenvalues over the absolute mass of every eigenvalue,
   * 0–1 (1 when every point coincides). Negative eigenvalues count against it, so distances no flat
   * map can hold lower it the way they raise the stress.
   */
  explained: number;
  /** Kruskal stress-1 of the map against the input dissimilarities (see kruskalStress). */
  stress: number;
}

export interface SymmetricEigen {
  /** Eigenvalues, largest first; equal values keep their diagonal order. */
  values: number[];
  /** vectors[k] is the unit eigenvector of values[k]. */
  vectors: number[][];
}

export interface TasteDistances {
  /** d_ij = 1 − sim_ij, symmetric with a zero diagonal. */
  d: number[][];
  /** Unordered pairs [i, j] (i < j) with no score, set to the largest scored distance. */
  imputed: [number, number][];
}

/** Sweeps of Jacobi rotations before giving up; a 14 × 14 matrix converges in well under 10. */
const MAX_SWEEPS = 64;
/** Converged once the off-diagonal mass falls below this share of the matrix's total mass. */
const OFF_DIAGONAL_TOLERANCE = 1e-24;
/** Eigenvalues within this share of the largest magnitude are float noise around 0 and read as 0. */
const ZERO_EIGENVALUE = 1e-12;
/** A point within this share of the axis's largest magnitude sits on its centre line and cannot orient it. */
const SIGN_TIE = 1e-9;
/** Input that is symmetric only up to float noise is accepted. */
const SYMMETRY_TOLERANCE = 1e-9;

/**
 * Taste distances from a pairwise similarity matrix: mirrored so either triangle may carry a pair
 * (two values average), then d = 1 − sim, floored at 0. A pair with no score means "no relationship"
 * (probe G1), so it takes the largest scored distance rather than a guess; with no scored pair at
 * all every distance is 1. The diagonal is ignored.
 */
export function tasteDistances(sim: readonly (readonly (number | null)[])[]): TasteDistances {
  const n = sim.length;
  if (sim.some((row) => row.length !== n)) throw new RangeError(`tasteDistances: sim must be ${n}×${n}`);
  const cell = (i: number, j: number): number | null => {
    const v = sim[i]![j] ?? null;
    return v !== null && Number.isFinite(v) ? v : null;
  };
  const d: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  const missing: [number, number][] = [];
  let farthest = 0;
  let scored = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = cell(i, j);
      const b = cell(j, i);
      const s = a === null ? b : b === null ? a : (a + b) / 2;
      if (s === null) {
        missing.push([i, j]);
        continue;
      }
      const dist = Math.max(0, 1 - s);
      d[i]![j] = dist;
      d[j]![i] = dist;
      farthest = Math.max(farthest, dist);
      scored += 1;
    }
  }
  const fill = scored === 0 ? 1 : farthest;
  for (const [i, j] of missing) {
    d[i]![j] = fill;
    d[j]![i] = fill;
  }
  return { d, imputed: missing };
}

/**
 * Classical MDS (Torgerson 1952): B = −½ J D⁽²⁾ J with the centring matrix J = I − 11ᵀ/n, then the
 * coordinates on axis k are √λ_k · v_k for the `dims` largest eigenvalues λ_k of B (a negative λ,
 * from distances no flat map can hold, contributes nothing). Each axis is oriented by the first
 * point, the subject when the caller puts it first: it sits on the negative side of axis 1 (left)
 * and the positive side of every other axis (up). A point on an axis's centre line cannot orient
 * it, so the next point off the line does; the map mirrors only when the orienting point crosses
 * the centre line, never under a near-tie elsewhere. Equal leading eigenvalues (a square, a
 * regular simplex) leave the axes free to rotate within their plane: the map is still deterministic
 * and its distances are unaffected.
 */
export function classicalMds(dissimilarity: readonly (readonly number[])[], dims = 2): MdsResult {
  const n = dissimilarity.length;
  validateDissimilarity(dissimilarity);
  if (!Number.isInteger(dims) || dims < 1) throw new RangeError(`classicalMds: dims must be a positive integer, got ${dims}`);
  if (n === 0) return { coords: [], eigenvalues: [], explained: 1, stress: 0 };

  const sq = dissimilarity.map((row) => row.map((v) => v * v));
  const rowMean = sq.map((row) => row.reduce((s, v) => s + v, 0) / n);
  const grandMean = rowMean.reduce((s, v) => s + v, 0) / n;
  const b = sq.map((row, i) => row.map((v, j) => -0.5 * (v - rowMean[i]! - rowMean[j]! + grandMean)));

  const eig = symmetricEigen(b);
  const top = Math.max(0, ...eig.values.map(Math.abs));
  const values = eig.values.map((x) => (Math.abs(x) <= ZERO_EIGENVALUE * top ? 0 : x));
  const coords: number[][] = Array.from({ length: n }, () => Array.from({ length: dims }, () => 0));
  for (let k = 0; k < Math.min(dims, n); k++) {
    const lambda = Math.max(0, values[k]!);
    const vector = oriented(eig.vectors[k]!, k === 0 ? -1 : 1);
    const scale = Math.sqrt(lambda);
    for (let i = 0; i < n; i++) coords[i]![k] = lambda === 0 ? 0 : vector[i]! * scale;
  }

  const mass = values.reduce((s, v) => s + Math.abs(v), 0);
  const kept = values.slice(0, dims).reduce((s, v) => s + Math.max(0, v), 0);
  return {
    coords,
    eigenvalues: values,
    explained: mass === 0 ? 1 : Math.min(1, kept / mass),
    stress: kruskalStress(dissimilarity, coords),
  };
}

/**
 * Kruskal's stress-1 (1964): √( Σ_{i<j} (δ_ij − d_ij)² / Σ_{i<j} δ_ij² ) between the input
 * dissimilarities δ and the map distances d. 0 is a perfect map; Kruskal read 0.05 as good, 0.1 as
 * fair and 0.2 as poor. 0 when every dissimilarity is 0.
 */
export function kruskalStress(dissimilarity: readonly (readonly number[])[], coords: readonly (readonly number[])[]): number {
  const n = dissimilarity.length;
  if (coords.length !== n) throw new RangeError(`kruskalStress: ${coords.length} points for a ${n}×${n} matrix`);
  let residual = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = dissimilarity[i]![j]!;
      const d = distance(coords[i]!, coords[j]!);
      residual += (delta - d) ** 2;
      total += delta * delta;
    }
  }
  return total === 0 ? 0 : Math.sqrt(residual / total);
}

/**
 * Eigen-decomposition of a real symmetric matrix by cyclic Jacobi rotations (pivots in row-major
 * order, every sweep), which is exact to float precision for the small matrices of a taste map and
 * involves no randomness. Vectors are unit length; their sign is whatever the rotations leave.
 */
export function symmetricEigen(matrix: readonly (readonly number[])[]): SymmetricEigen {
  const n = matrix.length;
  if (matrix.some((row) => row.length !== n)) throw new RangeError(`symmetricEigen: matrix must be ${n}×${n}`);
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let mass = 0;
  for (const row of a) for (const x of row) mass += x * x;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2;
    if (off <= OFF_DIAGONAL_TOLERANCE * mass) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (apq === 0) continue;
        // The rotation angle that zeroes a_pq, taken as the smaller root for stability.
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j]![j]! - a[i]![i]! || i - j);
  return {
    values: order.map((i) => a[i]![i]!),
    vectors: order.map((i) => v.map((row) => row[i]!)),
  };
}

/**
 * The vector flipped, if needed, so that the first entry off the centre line (above SIGN_TIE of the
 * largest magnitude) has the wanted sign: −1 for non-positive, 1 for non-negative.
 */
function oriented(vector: readonly number[], sign: -1 | 1): number[] {
  const top = Math.max(0, ...vector.map(Math.abs));
  if (top === 0) return [...vector];
  const lead = vector.findIndex((x) => Math.abs(x) > top * SIGN_TIE);
  return Math.sign(vector[lead]!) !== sign ? vector.map((x) => (x === 0 ? 0 : -x)) : [...vector];
}

function distance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let k = 0; k < Math.max(a.length, b.length); k++) s += ((a[k] ?? 0) - (b[k] ?? 0)) ** 2;
  return Math.sqrt(s);
}

/** Square, finite, non-negative, symmetric (to float noise) and zero on the diagonal. */
function validateDissimilarity(d: readonly (readonly number[])[]): void {
  const n = d.length;
  if (d.some((row) => row.length !== n)) throw new RangeError(`classicalMds: dissimilarity must be ${n}×${n}`);
  for (let i = 0; i < n; i++) {
    const row = d[i]!;
    for (let j = 0; j < n; j++) {
      const x = row[j]!;
      if (!Number.isFinite(x) || x < 0) throw new RangeError(`classicalMds: d[${i}][${j}] = ${x} is not a finite non-negative distance`);
      if (i === j && x !== 0) throw new RangeError(`classicalMds: d[${i}][${i}] must be 0`);
      const mirror = d[j]![i]!;
      if (Math.abs(x - mirror) > SYMMETRY_TOLERANCE * Math.max(1, Math.abs(x), Math.abs(mirror))) {
        throw new RangeError(`classicalMds: d[${i}][${j}] and d[${j}][${i}] differ`);
      }
    }
  }
}

/**
 * Numerical foundations: log-gamma (Lanczos), Poisson pmf, normal CDF,
 * softmax/sigmoid, and small vector utilities. Pure functions, no state.
 */

// Lanczos approximation coefficients (g = 7, n = 9)
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function, accurate to ~15 digits for z > 0. */
export function lgamma(z: number): number {
  if (z < 0.5) {
    // reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

/** ln(k!) memoised-free (lgamma is cheap and accurate). */
export function logFactorial(k: number): number {
  return lgamma(k + 1);
}

export function poissonLogPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(lambda) - lambda - logFactorial(k);
}

export function poissonPmf(k: number, lambda: number): number {
  return Math.exp(poissonLogPmf(k, lambda));
}

/** error function via Abramowitz–Stegun 7.1.26 (|ε| ≤ 1.5e-7). */
export function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) * t +
      0.254829592) * t) *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number, mu = 0, sd = 1): number {
  return 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sum(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function mean(xs: ArrayLike<number>): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((v) => (v - m) ** 2)) / (xs.length - 1));
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Numerically stable softmax over an array of logits. */
export function softmax(logits: number[]): number[] {
  const m = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - m));
  const s = sum(exps);
  return exps.map((e) => e / s);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Normalize a probability vector, clipping tiny negatives that arise from
 * floating point drift. Throws if the vector is degenerate.
 */
export function normalizeProbs(ps: number[], eps = 1e-12): number[] {
  const clipped = ps.map((p) => (p < 0 && p > -1e-9 ? 0 : p));
  const s = sum(clipped);
  if (!(s > eps) || !Number.isFinite(s)) {
    throw new Error(`normalizeProbs: degenerate vector sum=${s}`);
  }
  return clipped.map((p) => p / s);
}

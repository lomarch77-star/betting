/**
 * Deterministic, seedable randomness.
 *
 * Everything stochastic in the platform (demo data generation, model
 * subsampling, tie-breaking) flows through this module so that a given
 * (seed, config) pair always reproduces byte-identical outputs.
 */

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash → 32-bit unsigned int. Used to derive seeds from structured config. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Convenience RNG wrapper with gaussian / poisson / shuffle. Deterministic per seed. */
export class Rng {
  private nextU: () => number;
  private spareGauss: number | null = null;

  constructor(seed: number) {
    this.nextU = mulberry32(seed);
  }

  /** uniform in [0, 1) */
  next(): number {
    return this.nextU();
  }

  /** uniform in [min, max) */
  range(min: number, max: number): number {
    return min + (max - min) * this.nextU();
  }

  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** standard normal via Box–Muller (cached pair) */
  gaussian(mean = 0, sd = 1): number {
    if (this.spareGauss !== null) {
      const v = this.spareGauss;
      this.spareGauss = null;
      return mean + sd * v;
    }
    let u = 0;
    do {
      u = this.nextU();
    } while (u === 0);
    const v = this.nextU();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spareGauss = r * Math.sin(theta);
    return mean + sd * (r * Math.cos(theta));
  }

  /** Poisson sample. Knuth for small λ, normal approximation for λ ≥ 40. */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    if (lambda >= 40) {
      return Math.max(0, Math.round(this.gaussian(lambda, Math.sqrt(lambda))));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.nextU();
    } while (p > L);
    return k - 1;
  }

  /** in-place Fisher–Yates shuffle (deterministic) */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.nextU() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.nextU() * arr.length)];
  }
}

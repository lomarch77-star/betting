/**
 * Market pricing mathematics: odds formats, implied probability, overround,
 * margin removal, fair odds, expected value and closing-line value.
 *
 * All computations are pure and deterministic. Decimal odds are the internal
 * canonical format; fractional/American are supported only at the boundary.
 */

import { clamp } from './math';

export const MIN_DECIMAL_ODDS = 1.01;
export const MAX_DECIMAL_ODDS = 1000;

export function isValidDecimalOdds(o: number): boolean {
  return Number.isFinite(o) && o >= MIN_DECIMAL_ODDS && o <= MAX_DECIMAL_ODDS;
}

/** "5/2" → 3.5 */
export function decimalFromFractional(numerator: number, denominator: number): number {
  if (!(denominator > 0) || !(numerator > 0)) {
    throw new Error(`decimalFromFractional: invalid ${numerator}/${denominator}`);
  }
  return 1 + numerator / denominator;
}

/** +250 → 3.5, -200 → 1.5 */
export function decimalFromAmerican(american: number): number {
  if (!Number.isFinite(american) || american === 0) {
    throw new Error(`decimalFromAmerican: invalid ${american}`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function impliedProb(decimalOdds: number): number {
  if (!isValidDecimalOdds(decimalOdds)) {
    throw new Error(`impliedProb: invalid decimal odds ${decimalOdds}`);
  }
  return 1 / decimalOdds;
}

export interface OverroundReport {
  rawImplied: number[];
  totalImplied: number; // > 1 for any real book
  overround: number; // totalImplied - 1 (the bookmaker margin)
}

/** Raw implied probabilities and bookmaker overround for a full market. */
export function overround(decimalOdds: number[]): OverroundReport {
  const raw = decimalOdds.map(impliedProb);
  const total = raw.reduce((a, b) => a + b, 0);
  return { rawImplied: raw, totalImplied: total, overround: total - 1 };
}

/**
 * Remove margin by proportional scaling: p_i / Σp.
 * Simple and exact, but longshots keep too much probability.
 */
export function removeMarginProportional(decimalOdds: number[]): number[] {
  const { rawImplied, totalImplied } = overround(decimalOdds);
  return rawImplied.map((p) => clamp(p / totalImplied, 1e-9, 1));
}

/**
 * Remove margin by the power method: find k such that Σ p_i(k)^-1 ... i.e.
 * scale each implied prob as p_i' = (1/d_i)^(1/k) with Σ p_i' = 1, k ≥ 0
 * found by bisection. Better models favourite–longshot bias.
 */
export function removeMarginPower(decimalOdds: number[]): number[] {
  const raw = decimalOdds.map(impliedProb);
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 1)) return raw.map((p) => p); // fair or better — leave alone
  const powerSum = (k: number) =>
    raw.reduce((acc, p) => acc + Math.pow(p, 1 / k), 0);
  let lo = 1, hi = 100;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (powerSum(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const probs = raw.map((p) => Math.pow(p, 1 / k));
  const s = probs.reduce((a, b) => a + b, 0);
  return probs.map((p) => clamp(p / s, 1e-9, 1));
}

/** fair_odds = 1 / probability. The fundamental pricing invariant. */
export function fairOdds(probability: number): number {
  if (!(probability > 0) || !(probability <= 1)) {
    throw new Error(`fairOdds: probability out of range: ${probability}`);
  }
  return 1 / probability;
}

/** Expected value for a decimal price: EV = p × odds − 1 (e.g. 0.155 = +15.5%). */
export function expectedValue(probability: number, decimalOdds: number): number {
  if (!isValidDecimalOdds(decimalOdds)) {
    throw new Error(`expectedValue: invalid odds ${decimalOdds}`);
  }
  if (!(probability >= 0) || !(probability <= 1)) {
    throw new Error(`expectedValue: probability out of range: ${probability}`);
  }
  return probability * decimalOdds - 1;
}

/** Relative difference of market price vs model fair price: market/fair − 1. */
export function priceDifference(fair: number, market: number): number {
  if (!(fair > 0) || !(market > 0)) {
    throw new Error(`priceDifference: invalid prices fair=${fair} market=${market}`);
  }
  return market / fair - 1;
}

/**
 * Closing-line value expressed as the probability-point shift implied by
 * taking entry odds vs the closing price: impliedProb(close) − impliedProb(entry).
 * Positive ⇒ the market moved in the direction of the entry price.
 */
export function clvProbShift(entryOdds: number, closingOdds: number): number {
  return impliedProb(closingOdds) - impliedProb(entryOdds);
}

/** CLV in price-ratio terms: entry/close − 1 (positive = beat the close). */
export function clvRatio(entryOdds: number, closingOdds: number): number {
  if (!isValidDecimalOdds(entryOdds) || !isValidDecimalOdds(closingOdds)) {
    throw new Error('clvRatio: invalid odds');
  }
  return entryOdds / closingOdds - 1;
}

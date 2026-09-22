/**
 * Quantitative core invariants — the math layer must never lie.
 */
import { describe, it, expect } from 'vitest';
import {
  independentPoissonMatrix,
  dixonColesAdjust,
  deriveMarkets,
} from '@/lib/quant/poisson';
import {
  impliedProb,
  overround,
  removeMarginPower,
  removeMarginProportional,
  fairOdds,
  expectedValue,
  priceDifference,
  decimalFromFractional,
  decimalFromAmerican,
  clvRatio,
} from '@/lib/quant/pricing';
import { poissonPmf, lgamma, normalCdf } from '@/lib/quant/math';

describe('poisson engine', () => {
  it('score matrix sums to exactly 1', () => {
    const m = independentPoissonMatrix(1.55, 1.02);
    const total = m.flat().reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('pmf matches known values', () => {
    // P(X=0; λ=2) = e^-2 ≈ 0.135335283
    expect(poissonPmf(0, 2)).toBeCloseTo(0.135335283, 8);
    // P(X=3; λ=2) = e^-2 · 8/6 ≈ 0.180447044
    expect(poissonPmf(3, 2)).toBeCloseTo(0.180447044, 8);
  });

  it('lgamma accurate', () => {
    expect(lgamma(1)).toBeCloseTo(0, 10); // Γ(1)=1
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 10); // Γ(5)=24
  });

  it('normalCdf known points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it('derived markets are consistent with the matrix', () => {
    const m = independentPoissonMatrix(1.9, 0.8);
    const d = deriveMarkets(m);
    const pSum = d.oneXTwo.home + d.oneXTwo.draw + d.oneXTwo.away;
    expect(pSum).toBeCloseTo(1, 10);
    // home strongly favoured with λ 1.9 vs 0.8
    expect(d.oneXTwo.home).toBeGreaterThan(0.55);
    // O/U 2.5 sums to 1
    expect(d.overUnder[1].over + d.overUnder[1].under).toBeCloseTo(1, 10);
    // BTTS and correct scores consistent
    const bttsMatrix = m.flatMap((row, h) => row.filter((_, a) => h > 0 && a > 0)).reduce((a, b) => a + b, 0);
    expect(d.btts.yes).toBeCloseTo(bttsMatrix, 12);
    // double chance partitions
    expect(d.doubleChance.homeDraw + d.doubleChance.awayDraw - d.oneXTwo.draw).toBeCloseTo(1, 10);
    // DNB conditional normalisation
    expect(d.drawNoBet.home + d.drawNoBet.away).toBeCloseTo(1, 10);
    // expected goals ≥ 0
    expect(d.expectedGoals.home).toBeGreaterThan(0);
  });

  it('Dixon-Coles with negative rho raises 0-0 and 1-1', () => {
    const base = independentPoissonMatrix(1.3, 1.1);
    const adj = dixonColesAdjust(base, 1.3, 1.1, -0.12);
    expect(adj[0][0]).toBeGreaterThan(base[0][0]);
    expect(adj[1][1]).toBeGreaterThan(base[1][1]);
    expect(adj.flat().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('pricing', () => {
  it('implied probability = 1 / decimal odds', () => {
    expect(impliedProb(2.2)).toBeCloseTo(1 / 2.2, 12);
    expect(impliedProb(1.5)).toBeCloseTo(0.6666666667, 10);
  });

  it('fair odds = 1 / probability (spec invariant)', () => {
    expect(fairOdds(0.49)).toBeCloseTo(2.040816327, 9);
    expect(fairOdds(0.55)).toBeCloseTo(1.81818182, 8);
    expect(() => fairOdds(0)).toThrow();
    expect(() => fairOdds(-0.1)).toThrow();
    expect(() => fairOdds(1.2)).toThrow();
  });

  it('EV calculation is exact (spec example)', () => {
    // Model probability 0.55, odds 2.10 → EV = 0.55 × 2.10 − 1 = 0.155
    expect(expectedValue(0.55, 2.1)).toBeCloseTo(0.155, 12);
  });

  it('overround of a real book > 0; margin removal sums to 1', () => {
    const odds = [2.1, 3.5, 3.4];
    const o = overround(odds);
    expect(o.totalImplied).toBeGreaterThan(1);
    expect(o.overround).toBeCloseTo(o.totalImplied - 1, 15);
    for (const fn of [removeMarginProportional, removeMarginPower]) {
      const probs = fn(odds);
      expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
      probs.forEach((p) => {
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      });
    }
  });

  it('power margin removal preserves ordering', () => {
    const probs = removeMarginPower([1.8, 4.2, 4.6]);
    expect(probs[0]).toBeGreaterThan(probs[1]);
    expect(probs[1]).toBeGreaterThan(probs[2]);
  });

  it('price difference = market/fair − 1', () => {
    expect(priceDifference(2.04, 2.2)).toBeCloseTo(2.2 / 2.04 - 1, 12); // ≈ +7.8%
  });

  it('odds format conversions round-trip', () => {
    expect(decimalFromFractional(5, 2)).toBeCloseTo(3.5, 12);
    expect(decimalFromAmerican(250)).toBeCloseTo(3.5, 12);
    expect(decimalFromAmerican(-200)).toBeCloseTo(1.5, 12);
  });

  it('CLV ratio positive when entry beats close', () => {
    expect(clvRatio(2.2, 2.0)).toBeGreaterThan(0);
    expect(clvRatio(2.0, 2.2)).toBeLessThan(0);
  });
});

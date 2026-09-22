/**
 * Calibration & metrics invariants.
 */
import { describe, it, expect } from 'vitest';
import {
  fitIsotonic,
  fitPlatt,
  fitMulticlassCalibrator,
  calibrationBins,
  expectedCalibrationError,
} from '@/lib/quant/calibration';
import { computeBettingMetrics, logLossMulti, brierMulti } from '@/lib/quant/metrics';
import { assessDisagreement, buildUncertaintyReport } from '@/lib/quant/uncertainty';

describe('calibration', () => {
  it('isotonic fit is monotone non-decreasing', () => {
    const probs: number[] = [];
    const labels: number[] = [];
    // empirical freq increasing in p
    for (let i = 1; i <= 20; i++) {
      for (let j = 0; j < 30; j++) {
        probs.push(i / 21);
        labels.push(j < (i / 21) * 30 ? 1 : 0);
      }
    }
    const iso = fitIsotonic(probs, labels);
    let prev = -Infinity;
    for (let p = 0.05; p <= 0.95; p += 0.05) {
      const v = iso.predict(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it('platt fit outputs bounded probabilities', () => {
    const probs = Array.from({ length: 200 }, (_, i) => (i + 1) / 201);
    const labels = probs.map((p) => (p > 0.5 ? 1 : 0));
    const platt = fitPlatt(probs, labels);
    for (let p = 0.01; p < 1; p += 0.07) {
      const v = platt.predict(p);
      expect(v).toBeGreaterThanOrEqual(0.000001);
      expect(v).toBeLessThanOrEqual(0.999999);
    }
  });

  it('multiclass calibrator output sums to 1', () => {
    const rows: number[][] = [];
    const labels: number[] = [];
    for (let i = 0; i < 120; i++) {
      const p = [(i % 3) * 0.3 + 0.2, 0.3, 1 - ((i % 3) * 0.3 + 0.2) - 0.3];
      rows.push(p);
      labels.push(i % 3);
    }
    const cal = fitMulticlassCalibrator(rows, labels, 'isotonic');
    const out = cal.apply([0.5, 0.3, 0.2]);
    expect(out[0] + out[1] + out[2]).toBeCloseTo(1, 10);
    out.forEach((v) => {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    });
  });

  it('ECE ≈ 0 for a deliberately well-calibrated forecaster', () => {
    // forecaster whose predictions equal empirical frequency per bin
    const rows: number[][] = [];
    const labels: number[] = [];
    for (let b = 0; b < 10; b++) {
      const p = 0.3 + b * 0.05;
      for (let i = 0; i < 100; i++) {
        rows.push([p, 1 - p, 0].map((v, k) => (k === 2 ? 0.000001 : v - 0.0000005)));
        labels.push(i < p * 100 ? 0 : 1);
      }
    }
    const ece = expectedCalibrationError(rows, labels, 10);
    expect(ece).toBeLessThan(0.03);
  });

  it('calibration bins reconstruct aggregates', () => {
    const probs = [0.1, 0.15, 0.6, 0.9];
    const labels = [0, 0, 1, 1];
    const bins = calibrationBins(probs, labels, 10);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(bins[0].count).toBe(0);
    expect(bins[9].empirical).toBe(1);
  });
});

describe('metrics & uncertainty', () => {
  it('bankroll curve, drawdown and streaks are exactly right on toy data', () => {
    const bets = [
      { entryOdds: 2.0, stake: 1, pnl: 1, won: true, settledAt: '2025-01-01T00:00:00Z' },
      { entryOdds: 2.0, stake: 1, pnl: -1, won: false, settledAt: '2025-01-02T00:00:00Z' },
      { entryOdds: 2.0, stake: 1, pnl: -1, won: false, settledAt: '2025-01-03T00:00:00Z' },
      { entryOdds: 2.0, stake: 1, pnl: -1, won: false, settledAt: '2025-01-04T00:00:00Z' },
      { entryOdds: 2.0, stake: 1, pnl: 1, won: true, settledAt: '2025-01-05T00:00:00Z' },
    ];
    const m = computeBettingMetrics(bets, 100);
    expect(m.finalBankroll).toBeCloseTo(99, 10);
    expect(m.roi).toBeCloseTo(-1 / 5, 10);
    expect(m.longestLosingStreak).toBe(3);
    // bankroll path: 100 → 101 (peak) → 100 → 99 → 98 (trough) → 99 ⇒ drawdown 3
    expect(m.maxDrawdown).toBeCloseTo(3, 10);
    expect(m.hitRate).toBeCloseTo(0.4, 10);
    expect(m.bankrollSeries[m.bankrollSeries.length - 1].value).toBeCloseTo(99, 10);
  });

  it('shuffled input order still yields chronological processing', () => {
    const mk = (day: number, pnl: number, won: boolean) => ({
      entryOdds: 2,
      stake: 1,
      pnl,
      won,
      settledAt: `2025-01-0${day}T00:00:00Z`,
    });
    const a = computeBettingMetrics([mk(1, 1, true), mk(3, -1, false), mk(2, -1, false)], 10);
    const b = computeBettingMetrics([mk(3, -1, false), mk(1, 1, true), mk(2, -1, false)], 10);
    expect(JSON.stringify(a.bankrollSeries)).toBe(JSON.stringify(b.bankrollSeries));
    expect(b.maxDrawdown).toBeCloseTo(2, 10);
  });

  it('logLoss/Brier are minimal at the true label', () => {
    const rows = [
      [0.7, 0.2, 0.1],
      [0.1, 0.3, 0.6],
    ];
    const labels = [0, 2];
    expect(logLossMulti(rows, labels)).toBeLessThan(logLossMulti(rows, [1, 1]));
    expect(brierMulti(rows, labels)).toBeLessThan(brierMulti(rows, [1, 1]));
  });

  it('disagreement assessment categories behave sanely', () => {
    const tight = assessDisagreement([
      { kind: 'A', probs: { home: 0.5, draw: 0.27, away: 0.23 } },
      { kind: 'B', probs: { home: 0.51, draw: 0.26, away: 0.23 } },
    ]);
    expect(tight.label).toBe('BROAD');
    const split = assessDisagreement([
      { kind: 'A', probs: { home: 0.7, draw: 0.18, away: 0.12 } },
      { kind: 'B', probs: { home: 0.15, draw: 0.25, away: 0.6 } },
    ]);
    expect(split.label).toBe('SPLIT');
    expect(buildUncertaintyReport({
      agreement: split,
      qualityStatus: 'VALID',
      calibration: 'GOOD',
      historicalSample: 5000,
    }).notes.length).toBeGreaterThan(0);
  });
});

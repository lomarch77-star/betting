/**
 * Model invariants (spec §35):
 *   - every model produces probabilities in (0,1) summing to ~1
 *   - models learn signal (beat the ignorant baseline on synthetic data)
 *   - ensemble weights normalise
 */
import { describe, it, expect } from 'vitest';
import { buildTinyUniverse } from './helpers/tinyUniverse';
import { fitEnsembleAt, predictFixture } from '@/lib/models/pipeline';
import { combineProbabilities, fitEnsembleWeights, DEFAULT_ENSEMBLE_WEIGHTS } from '@/lib/models/ensemble';
import { logLossMulti } from '@/lib/quant/metrics';
import { finishedBefore } from '@/lib/db/repos-core';
import { prob3ToArray } from '@/lib/types';
import type { PipelineConfig } from '@/lib/models/pipeline';
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models/pipeline';

const LIGHT: PipelineConfig = {
  ...DEFAULT_PIPELINE_CONFIG,
  trainSpanDays: 500,
  valSpanDays: 60,
  minValRows: 20,
  strength: { ...DEFAULT_PIPELINE_CONFIG.strength, iterations: 120 },
  logistic: { ...DEFAULT_PIPELINE_CONFIG.logistic, iterations: 160 },
  gbm: { ...DEFAULT_PIPELINE_CONFIG.gbm, rounds: 14, thresholdCount: 6 },
};

describe('model probability invariants', () => {
  const universe = buildTinyUniverse(7, 56);
  const asOf = new Date(Date.parse(universe.endIso) - 40 * 86_400_000).toISOString();
  const fitted = fitEnsembleAt(universe.db, asOf, LIGHT, {
    competitionId: universe.competitionId,
  });
  const testMatches = finishedBefore(universe.db, universe.endIso, {
    competitionId: universe.competitionId,
    from: asOf,
  });

  it('all four component models produce valid probability triples', () => {
    for (const m of testMatches.slice(0, 6)) {
      const pred = predictFixture(fitted, m);
      for (const [kind, p] of Object.entries(pred.perModel)) {
        const arr = prob3ToArray(p);
        for (const v of arr) {
          expect(v, `${kind} prob in range`).toBeGreaterThan(0);
          expect(v, `${kind} prob in range`).toBeLessThan(1);
        }
        const s = arr[0] + arr[1] + arr[2];
        expect(s, `${kind} sums to 1`).toBeCloseTo(1, 6);
      }
      const e = prob3ToArray(pred.ensemble);
      expect(e[0] + e[1] + e[2]).toBeCloseTo(1, 6);
    }
  });

  it('ensemble weights are non-negative and sum to 1', () => {
    const w = fitted.weights;
    for (const v of Object.values(w)) expect(v).toBeGreaterThanOrEqual(0);
    expect(w.ELO + w.POISSON + w.LOGISTIC + w.GBM).toBeCloseTo(1, 8);
  });

  it('poisson model learns skill ranking better than ignorant baseline', () => {
    // baseline: ignorant 3-way at league frequencies
    let h = 0, d = 0, a = 0;
    for (const m of finishedBefore(universe.db, asOf, { competitionId: universe.competitionId })) {
      if (m.home_goals! > m.away_goals!) h++;
      else if (m.home_goals! === m.away_goals!) d++;
      else a++;
    }
    const n = h + d + a;
    const base = [h / n, d / n, a / n];
    const labels = testMatches.map((m) => (m.home_goals! > m.away_goals! ? 0 : m.home_goals! === m.away_goals! ? 1 : 2));
    const baseRows = labels.map(() => base);
    const baseLoss = logLossMulti(baseRows, labels);
    const modelRows = testMatches.map((m) => {
      const p = predictFixture(fitted, m).perModel.POISSON;
      return prob3ToArray(p);
    });
    const modelLoss = logLossMulti(modelRows, labels);
    expect(modelLoss).toBeLessThan(baseLoss);
  });

  it('ensemble combine of default weights yields valid distribution', () => {
    const pred = predictFixture(fitted, testMatches[0]);
    const e = combineProbabilities(pred.perModel, DEFAULT_ENSEMBLE_WEIGHTS);
    const arr = prob3ToArray(e);
    expect(arr[0] + arr[1] + arr[2]).toBeCloseTo(1, 10);
  });

  it('weight fitting converges to weights at least as good as default on validation', () => {
    const n = 200;
    const labels = Array.from({ length: n }, (_, i) => i % 3);
    // model 0 is perfect; others are uniform — optimal weight: model 0 = 1
    const good = labels.map((l) => [0.001, 0.001, 0.001].map((v, k) => (k === l ? 0.998 : v)));
    const flat = labels.map(() => [1 / 3, 1 / 3, 1 / 3]);
    const { weights } = fitEnsembleWeights([good, flat, flat, flat], labels);
    expect(weights.ELO).toBeGreaterThan(0.85);
  });
});

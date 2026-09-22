/**
 * Ensemble layer (spec §10).
 *
 * Weighted geometric-or-arithmetic combination of the base models. V1 uses
 * arithmetic averaging (robust, keeps probabilities well-formed by
 * construction) with weights derived from VALIDATION log loss via a
 * deterministic simplex grid search — never hand-picked silently.
 *
 * The exact ensemble configuration (weights, model version ids, calibration
 * method) is recorded alongside every persisted prediction for audit.
 */

import { logLossMulti } from '@/lib/quant/metrics';
import { normalizeProbs } from '@/lib/quant/math';
import type { Prob3 } from '@/lib/types';

export interface EnsembleWeights {
  ELO: number;
  POISSON: number;
  LOGISTIC: number;
  GBM: number;
}

export const DEFAULT_ENSEMBLE_WEIGHTS: EnsembleWeights = {
  ELO: 0.2,
  POISSON: 0.35,
  LOGISTIC: 0.2,
  GBM: 0.25,
};

export function combineProbabilities(
  probs: Record<keyof EnsembleWeights, Prob3>,
  weights: EnsembleWeights,
): Prob3 {
  const totalW = weights.ELO + weights.POISSON + weights.LOGISTIC + weights.GBM;
  if (!(totalW > 0)) throw new Error('combineProbabilities: weights sum to zero');
  const [h, d, a] = normalizeProbs([
    weights.ELO * probs.ELO.home +
      weights.POISSON * probs.POISSON.home +
      weights.LOGISTIC * probs.LOGISTIC.home +
      weights.GBM * probs.GBM.home,
    weights.ELO * probs.ELO.draw +
      weights.POISSON * probs.POISSON.draw +
      weights.LOGISTIC * probs.LOGISTIC.draw +
      weights.GBM * probs.GBM.draw,
    weights.ELO * probs.ELO.away +
      weights.POISSON * probs.POISSON.away +
      weights.LOGISTIC * probs.LOGISTIC.away +
      weights.GBM * probs.GBM.away,
  ]);
  return { home: h, draw: d, away: a };
}

export function weightsToArray(w: EnsembleWeights): number[] {
  return [w.ELO, w.POISSON, w.LOGISTIC, w.GBM];
}

export function weightsFromArray(a: number[]): EnsembleWeights {
  return { ELO: a[0], POISSON: a[1], LOGISTIC: a[2], GBM: a[3] };
}

/**
 * Deterministic simplex grid search (step 0.05, refinement 0.01) minimising
 * validation log loss. Validation rows MUST be out-of-sample relative to the
 * base models — enforced by the pipeline's hold-out-then-refit scheme.
 */
export function fitEnsembleWeights(
  perModelRows: number[][][], // [model][row][class] — 4 models
  labels: number[],
  coarseStep = 0.05,
): { weights: EnsembleWeights; validationLogLoss: number } {
  const nModels = perModelRows.length;
  const units = Math.round(1 / coarseStep);

  const evaluate = (w: number[]): number => {
    const rows: number[][] = [];
    const n = perModelRows[0].length;
    for (let i = 0; i < n; i++) {
      const comb = [0, 0, 0];
      for (let m = 0; m < nModels; m++) {
        for (let k = 0; k < 3; k++) comb[k] += w[m] * perModelRows[m][i][k];
      }
      const s = comb[0] + comb[1] + comb[2];
      rows.push([comb[0] / s, comb[1] / s, comb[2] / s]);
    }
    return logLossMulti(rows, labels);
  };

  let bestW = weightsToArray(DEFAULT_ENSEMBLE_WEIGHTS);
  let bestLoss = evaluate(bestW);

  const grid: number[][] = [];
  for (let a = 0; a <= units; a++)
    for (let b = 0; b <= units - a; b++)
      for (let c = 0; c <= units - a - b; c++) {
        const dd = units - a - b - c;
        grid.push([a / units, b / units, c / units, dd / units]);
      }
  for (const w of grid) {
    const loss = evaluate(w);
    if (loss < bestLoss - 1e-12) {
      bestLoss = loss;
      bestW = w;
    }
  }

  // refinement pass around the coarse optimum
  const step = 0.01;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 8) {
    improved = false;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        for (const dir of [-1, 1]) {
          const w = [...bestW];
          const delta = dir * step;
          if (w[i] + delta < 0 || w[j] - delta < 0) continue;
          w[i] += delta;
          w[j] -= delta;
          const loss = evaluate(w);
          if (loss < bestLoss - 1e-12) {
            bestLoss = loss;
            bestW = w;
            improved = true;
          }
        }
      }
    }
  }

  return { weights: weightsFromArray(bestW), validationLogLoss: bestLoss };
}

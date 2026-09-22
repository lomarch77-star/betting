/**
 * Multinomial logistic (softmax) regression — one of the four V1 result
 * models. Pure TypeScript, full-batch gradient descent with momentum and L2
 * regularisation. Deterministic: fixed iteration schedule, no sampling.
 *
 * Features are z-standardised; the standardisation statistics are stored
 * inside the model so predict-time transforms are reproducible.
 */

import { softmax, clamp } from '@/lib/quant/math';

export interface LogisticParams {
  iterations: number;
  learningRate: number;
  l2: number;
}

export const DEFAULT_LOGISTIC_PARAMS: LogisticParams = {
  iterations: 500,
  learningRate: 0.1,
  l2: 0.001,
};

export interface SoftmaxModel {
  means: number[];
  stds: number[];
  W: number[][]; // [feature][class]
  b: number[]; // [class]
  trainedOn: number;
  featureNames: string[];
}

export function standardize(X: number[][]): { X: number[][]; means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0].length;
  const means = new Array<number>(d).fill(0);
  const stds = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i][j];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - m) ** 2;
    v = Math.sqrt(v / Math.max(1, n - 1));
    means[j] = m;
    stds[j] = v < 1e-9 ? 1 : v;
  }
  const Xs = X.map((row) => row.map((x, j) => clamp((x - means[j]) / stds[j], -8, 8)));
  return { X: Xs, means, stds };
}

export function trainSoftmax(
  X: number[][],
  y: number[], // class index 0..K-1
  params: LogisticParams = DEFAULT_LOGISTIC_PARAMS,
  featureNames?: string[],
): SoftmaxModel {
  const n = X.length;
  if (n === 0) throw new Error('trainSoftmax: empty training set');
  const d = X[0].length;
  const K = Math.max(...y) + 1;
  const { X: Xs, means, stds } = standardize(X);

  const W: number[][] = Array.from({ length: d }, () => new Array<number>(K).fill(0));
  const b: number[] = new Array<number>(K).fill(0);
  const velW: number[][] = Array.from({ length: d }, () => new Array<number>(K).fill(0));
  const velB: number[] = new Array<number>(K).fill(0);
  const momentum = 0.9;
  const P = new Array<number>(K).fill(0);

  for (let iter = 0; iter < params.iterations; iter++) {
    const lr = params.learningRate / (1 + 0.004 * iter);
    const gW: number[][] = Array.from({ length: d }, () => new Array<number>(K).fill(0));
    const gB: number[] = new Array<number>(K).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = Xs[i];
      let zmax = -Infinity;
      for (let k = 0; k < K; k++) {
        let z = b[k];
        for (let j = 0; j < d; j++) z += W[j][k] * xi[j];
        P[k] = z;
        if (z > zmax) zmax = z;
      }
      let zsum = 0;
      for (let k = 0; k < K; k++) {
        P[k] = Math.exp(P[k] - zmax);
        zsum += P[k];
      }
      for (let k = 0; k < K; k++) {
        P[k] /= zsum;
        const e = P[k] - (y[i] === k ? 1 : 0);
        gB[k] += e;
        for (let j = 0; j < d; j++) gW[j][k] += e * xi[j];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < K; k++) {
        const g = gW[j][k] / n + params.l2 * W[j][k];
        velW[j][k] = momentum * velW[j][k] - lr * g;
        W[j][k] += velW[j][k];
      }
    }
    for (let k = 0; k < K; k++) {
      velB[k] = momentum * velB[k] - lr * (gB[k] / n);
      b[k] += velB[k];
    }
  }

  return { means, stds, W, b, trainedOn: n, featureNames: featureNames ?? [] };
}

export function predictSoftmaxProbs(model: SoftmaxModel, x: number[]): number[] {
  const d = model.means.length;
  const xs = new Array<number>(d);
  for (let j = 0; j < d; j++) xs[j] = clamp((x[j] - model.means[j]) / model.stds[j], -8, 8);
  const logits = model.b.map((bk, k) => {
    let z = bk;
    for (let j = 0; j < d; j++) z += model.W[j][k] * xs[j];
    return z;
  });
  return softmax(logits);
}

/**
 * Feature importances for explanation: |W_j| column norm per feature
 * (standardised scale), sorted descending. Deterministic, model-derived —
 * the analyst layer reads these instead of inventing reasons.
 */
export function featureImportances(
  model: SoftmaxModel,
  featureNames: string[],
): Array<{ feature: string; importance: number; directionHome: number }> {
  const d = model.W.length;
  const out = [];
  for (let j = 0; j < d; j++) {
    const w = model.W[j];
    const norm = Math.sqrt(w.reduce((a, v) => a + v * v, 0));
    out.push({
      feature: featureNames[j] ?? `feature_${j}`,
      importance: norm,
      directionHome: w[0] - w[2], // positive ⇒ pushes P(home) up vs P(away)
    });
  }
  return out.sort((a, b) => b.importance - a.importance);
}

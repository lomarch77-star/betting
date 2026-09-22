/**
 * Probability calibration — the mandatory layer between raw model scores and
 * any probability shown to a user (spec §11).
 *
 * Supports: Platt scaling, isotonic regression (PAVA), multiclass extension
 * by one-vs-rest + renormalization, calibration curves/bins, Brier, log loss,
 * and expected calibration error. Prediction accuracy and probability
 * calibration are reported as distinct, separate quantities.
 */

import { clamp, sigmoid, normalizeProbs } from './math';
import { logLossMulti, brierMulti } from './metrics';

export interface BinaryCalibrator {
  kind: 'platt' | 'isotonic';
  predict(p: number): number;
}

/** Platt scaling: logistic regression on the raw probability score. */
export function fitPlatt(probs: number[], labels01: number[]): BinaryCalibrator {
  const n = probs.length;
  if (n < 10) return { kind: 'platt', predict: (p) => p };
  // Newton iterations for 1-D logistic regression: sigmoid(a·p + b)
  let a = 0, b = 0;
  for (let iter = 0; iter < 200; iter++) {
    let gA = 0, gB = 0, hAA = 1e-6, hAB = 0, hBB = 1e-6;
    for (let i = 0; i < n; i++) {
      const p = clamp(probs[i], 1e-6, 1 - 1e-6);
      const q = sigmoid(a * p + b);
      const e = q - labels01[i];
      gA += e * p;
      gB += e;
      const w = Math.max(q * (1 - q), 1e-6);
      hAA += w * p * p;
      hAB += w * p;
      hBB += w;
    }
    const det = hAA * hBB - hAB * hAB;
    if (Math.abs(det) < 1e-12) break;
    const dA = (gA * hBB - gB * hAB) / det;
    const dB = (hAA * gB - hAB * gA) / det;
    a -= dA;
    b -= dB;
    if (Math.abs(dA) + Math.abs(dB) < 1e-10) break;
  }
  const A = a, B = b;
  return {
    kind: 'platt',
    predict: (p) => clamp(sigmoid(A * clamp(p, 1e-6, 1 - 1e-6) + B), 1e-6, 1 - 1e-6),
  };
}

/**
 * Isotonic regression via pool-adjacent-violators (PAVA).
 *
 * Prediction is piecewise-LINEAR through the pooled-block knots (sklearn-style
 * isotonic), not piecewise-constant: monotone non-decreasing, but it does not
 * collapse input variation inside wide blocks — important with small
 * validation samples, where a step function would map many distinct fixture
 * probabilities to the same constant.
 */
export function fitIsotonic(probs: number[], labels01: number[]): BinaryCalibrator {
  const n = probs.length;
  if (n < 10) return { kind: 'isotonic', predict: (p) => p };
  const idx = probs.map((_, i) => i).sort((x, y) => probs[x] - probs[y]);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const i of idx) {
    xs.push(probs[i]);
    ys.push(labels01[i]);
  }
  // PAVA: merge adjacent blocks while violators exist (weighted means).
  interface Block { start: number; end: number; value: number; weight: number }
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ start: i, end: i, value: ys[i], weight: 1 });
    while (blocks.length >= 2) {
      const b2 = blocks[blocks.length - 1];
      const b1 = blocks[blocks.length - 2];
      if (b1.value < b2.value) break;
      const wSum = b1.weight + b2.weight;
      blocks.splice(
        blocks.length - 2,
        2,
        {
          start: b1.start,
          end: b2.end,
          value: (b1.value * b1.weight + b2.value * b2.weight) / wSum,
          weight: wSum,
        },
      );
    }
  }
  // One knot per pooled block: x = mean of the block's observed scores.
  const knots: Array<{ x: number; y: number }> = blocks.map((b) => {
    let sx = 0;
    for (let i = b.start; i <= b.end; i++) sx += xs[i];
    return {
      x: sx / (b.end - b.start + 1),
      y: clamp(b.value, 1e-6, 1 - 1e-6),
    };
  });
  // Fold duplicate-x knots (can occur with tied probabilities).
  const uniq: Array<{ x: number; y: number }> = [];
  for (const k of knots) {
    const prev = uniq[uniq.length - 1];
    if (prev && Math.abs(prev.x - k.x) < 1e-12) prev.y = k.y;
    else uniq.push({ ...k });
  }
  return {
    kind: 'isotonic',
    predict: (p) => {
      if (uniq.length === 1) return uniq[0].y;
      if (p <= uniq[0].x) return uniq[0].y;
      for (let i = 1; i < uniq.length; i++) {
        const right = uniq[i];
        if (p <= right.x) {
          const left = uniq[i - 1];
          const t = right.x - left.x < 1e-12 ? 0.5 : (p - left.x) / (right.x - left.x);
          return clamp(left.y + t * (right.y - left.y), 1e-6, 1 - 1e-6);
        }
      }
      return uniq[uniq.length - 1].y;
    },
  };
}

/** Multiclass calibrator: per-class one-vs-rest + renormalization. */
export interface MulticlassCalibrator {
  method: 'platt' | 'isotonic';
  perClass: BinaryCalibrator[];
  apply(ps: number[]): number[];
}

export function fitMulticlassCalibrator(
  probRows: number[][],
  labelIdx: number[],
  method: 'platt' | 'isotonic',
): MulticlassCalibrator {
  const classes = probRows[0]?.length ?? 0;
  const perClass: BinaryCalibrator[] = [];
  for (let k = 0; k < classes; k++) {
    const pk = probRows.map((r) => r[k]);
    const yk = labelIdx.map((l) => (l === k ? 1 : 0));
    perClass.push(method === 'platt' ? fitPlatt(pk, yk) : fitIsotonic(pk, yk));
  }
  return {
    method,
    perClass,
    apply: (ps: number[]) => {
      const raw = perClass.map((c, k) => c.predict(ps[k]));
      return normalizeProbs(raw);
    },
  };
}

/** Binned calibration curve for one class: mean predicted vs empirical frequency. */
export interface CalibrationBin {
  binStart: number;
  binEnd: number;
  count: number;
  meanPredicted: number;
  empirical: number;
}

export function calibrationBins(
  probs: number[],
  labels01: number[],
  binCount = 10,
): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: binCount }, (_, i) => ({
    binStart: i / binCount,
    binEnd: (i + 1) / binCount,
    count: 0,
    meanPredicted: 0,
    empirical: 0,
  }));
  for (let i = 0; i < probs.length; i++) {
    const b = Math.min(binCount - 1, Math.floor(probs[i] * binCount));
    bins[b].count++;
    bins[b].meanPredicted += probs[i];
    bins[b].empirical += labels01[i];
  }
  for (const b of bins) {
    if (b.count > 0) {
      b.meanPredicted /= b.count;
      b.empirical /= b.count;
    }
  }
  return bins;
}

/** Expected calibration error on the top-label (confidence) view. */
export function expectedCalibrationError(
  probRows: number[][],
  labelIdx: number[],
  binCount = 10,
): number {
  const n = probRows.length;
  if (n === 0) return NaN;
  const conf: number[] = [];
  const hit: number[] = [];
  for (let i = 0; i < n; i++) {
    let argmax = 0;
    for (let k = 1; k < probRows[i].length; k++)
      if (probRows[i][k] > probRows[i][argmax]) argmax = k;
    conf.push(probRows[i][argmax]);
    hit.push(argmax === labelIdx[i] ? 1 : 0);
  }
  const bins = calibrationBins(conf, hit, binCount);
  let ece = 0;
  for (const b of bins) {
    if (b.count > 0) ece += (b.count / n) * Math.abs(b.meanPredicted - b.empirical);
  }
  return ece;
}

export interface CalibrationReport {
  sample: number;
  logLoss: number;
  brier: number;
  ece: number;
  binsPerClass: CalibrationBin[][];
}

export function calibrationReport(
  probRows: number[][],
  labelIdx: number[],
  binCount = 10,
): CalibrationReport {
  const classes = probRows[0]?.length ?? 0;
  const binsPerClass: CalibrationBin[][] = [];
  for (let k = 0; k < classes; k++) {
    binsPerClass.push(
      calibrationBins(
        probRows.map((r) => r[k]),
        labelIdx.map((l) => (l === k ? 1 : 0)),
        binCount,
      ),
    );
  }
  return {
    sample: probRows.length,
    logLoss: logLossMulti(probRows, labelIdx),
    brier: brierMulti(probRows, labelIdx),
    ece: expectedCalibrationError(probRows, labelIdx, binCount),
    binsPerClass,
  };
}

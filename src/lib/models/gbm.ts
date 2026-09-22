/**
 * Multinomial gradient boosting over small regression trees — the fourth V1
 * result model. Pure TypeScript, fully deterministic:
 *   - fixed iteration schedule, quantile thresholds, no row subsampling
 *     by default (subsample=1); if subsampling is enabled it is driven by a
 *     seeded Rng so runs remain reproducible.
 *
 * K one-vs-rest residual trees per round; additive log-odds space with a
 * softmax link. Initial margin = log of class priors.
 */

import { softmax, clamp, mean } from '@/lib/quant/math';
import { Rng } from '@/lib/quant/random';

export interface GbmParams {
  rounds: number;
  learningRate: number;
  maxDepth: number;
  minLeaf: number;
  thresholdCount: number; // candidate split points per feature (quantiles)
  subsample: number; // 1 = deterministic full data
  seed: number;
}

export const DEFAULT_GBM_PARAMS: GbmParams = {
  rounds: 36,
  learningRate: 0.12,
  maxDepth: 3,
  minLeaf: 25,
  thresholdCount: 10,
  subsample: 1,
  seed: 7,
};

interface TreeNode {
  feature?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  value: number; // leaf value (node mean when leaf)
}

interface RoundTree {
  trees: TreeNode[]; // one per class
}

export interface GbmModel {
  initLogits: number[];
  lr: number;
  rounds: RoundTree[];
  means: number[];
  stds: number[];
  trainedOn: number;
  classes: number;
  featureNames: string[];
  splitGains: number[]; // cumulative gain per feature — explanation support
}

function leafValue(residuals: number[], idx: number[]): number {
  let s = 0;
  for (const i of idx) s += residuals[i];
  return s / Math.max(1, idx.length);
}

function sse(residuals: number[], idx: number[]): number {
  if (idx.length === 0) return 0;
  const m = leafValue(residuals, idx);
  let s = 0;
  for (const i of idx) {
    const d = residuals[i] - m;
    s += d * d;
  }
  return s;
}

function buildTree(
  X: number[][],
  residual: number[],
  idx: number[],
  thresholds: number[][],
  params: GbmParams,
  depth: number,
  splitGains: number[],
): TreeNode {
  const value = leafValue(residual, idx);
  if (depth >= params.maxDepth || idx.length < 2 * params.minLeaf) {
    return { value };
  }
  const parentSse = sse(residual, idx);
  let best: { feature: number; threshold: number; gain: number; li: number[]; ri: number[] } | null =
    null;
  const d = X[0].length;
  for (let j = 0; j < d; j++) {
    for (const t of thresholds[j]) {
      const li: number[] = [];
      const ri: number[] = [];
      for (const i of idx) {
        if (X[i][j] <= t) li.push(i);
        else ri.push(i);
      }
      if (li.length < params.minLeaf || ri.length < params.minLeaf) continue;
      const gain = parentSse - sse(residual, li) - sse(residual, ri);
      if (gain > 1e-12 && (best === null || gain > best.gain)) {
        best = { feature: j, threshold: t, gain, li, ri };
      }
    }
  }
  if (!best) return { value };
  splitGains[best.feature] += best.gain;
  return {
    feature: best.feature,
    threshold: best.threshold,
    value,
    left: buildTree(X, residual, best.li, thresholds, params, depth + 1, splitGains),
    right: buildTree(X, residual, best.ri, thresholds, params, depth + 1, splitGains),
  };
}

function treePredict(node: TreeNode, x: number[]): number {
  let n = node;
  while (n.feature !== undefined) {
    n = x[n.feature] <= n.threshold! ? n.left! : n.right!;
  }
  return n.value;
}

function quantileThresholds(X: number[][], count: number): number[][] {
  const n = X.length;
  const d = X[0].length;
  const out: number[][] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]).sort((a, b) => a - b);
    const ts: number[] = [];
    for (let q = 1; q <= count; q++) {
      const pos = Math.floor((q / (count + 1)) * (n - 1));
      const v = col[pos];
      if (ts.length === 0 || v > ts[ts.length - 1]) ts.push(v);
    }
    out.push(ts);
  }
  return out;
}

export function trainGbm(
  X: number[][],
  y: number[],
  params: GbmParams = DEFAULT_GBM_PARAMS,
  featureNames?: string[],
): GbmModel {
  const n = X.length;
  if (n < 30) throw new Error('trainGbm: insufficient rows');
  const d = X[0].length;
  const K = Math.max(...y) + 1;

  // standardize features (stored for reproducible predict-time transform)
  const means = new Array<number>(d).fill(0);
  const stds = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]);
    means[j] = mean(col);
    const v = Math.sqrt(mean(col.map((c) => (c - means[j]) ** 2)));
    stds[j] = v < 1e-9 ? 1 : v;
  }
  const Xs = X.map((r) => r.map((x, j) => clamp((x - means[j]) / stds[j], -10, 10)));

  const classCounts = new Array<number>(K).fill(0);
  for (const yy of y) classCounts[yy]++;
  const initLogits = classCounts.map((c) => Math.log((c + 1) / (n + K)));

  const rng = new Rng(params.seed);
  const F: number[][] = Xs.map(() => [...initLogits]);
  const rounds: RoundTree[] = [];
  const splitGains = new Array<number>(d).fill(0);
  const allIdx = Xs.map((_, i) => i);

  for (let round = 0; round < params.rounds; round++) {
    const idx =
      params.subsample >= 1
        ? allIdx
        : rng.shuffle([...allIdx]).slice(0, Math.max(30, Math.floor(n * params.subsample)));
    const thresholds = quantileThresholds(idx.map((i) => Xs[i]), params.thresholdCount);
    const Xsub = idx.map((i) => Xs[i]);
    const trees: TreeNode[] = [];
    for (let k = 0; k < K; k++) {
      const residual = idx.map((i) => {
        const p = softmax(F[i])[k];
        return (y[i] === k ? 1 : 0) - p;
      });
      const localIdx = idx.map((_, i) => i);
      const tree = buildTree(
        Xsub,
        residual,
        localIdx,
        thresholds,
        params,
        0,
        splitGains,
      );
      trees.push(tree);
      for (let ii = 0; ii < idx.length; ii++) {
        F[idx[ii]][k] += params.learningRate * treePredict(tree, Xsub[ii]);
      }
    }
    rounds.push({ trees });
  }

  return {
    initLogits,
    lr: params.learningRate,
    rounds,
    means,
    stds,
    trainedOn: n,
    classes: K,
    featureNames: featureNames ?? [],
    splitGains,
  };
}

export function predictGbmProbs(model: GbmModel, x: number[]): number[] {
  const d = model.means.length;
  const xs = new Array<number>(d);
  for (let j = 0; j < d; j++) xs[j] = clamp((x[j] - model.means[j]) / model.stds[j], -10, 10);
  const logits = [...model.initLogits];
  for (const r of model.rounds) {
    for (let k = 0; k < model.classes; k++) {
      logits[k] += model.lr * treePredict(r.trees[k], xs);
    }
  }
  return softmax(logits);
}

/** Relative split-gain importances → deterministic feature explanation. */
export function gbmImportances(
  model: GbmModel,
): Array<{ feature: string; importance: number }> {
  const total = model.splitGains.reduce((a, b) => a + b, 0);
  return model.splitGains
    .map((g, j) => ({
      feature: model.featureNames[j] ?? `feature_${j}`,
      importance: total > 0 ? g / total : 0,
    }))
    .sort((a, b) => b.importance - a.importance);
}

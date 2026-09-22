/**
 * Goal-distribution engine.
 *
 * Given expected goals (λ_home, λ_away) this module builds the joint score
 * probability matrix and derives every V1 football match market from it:
 * 1X2, over/under lines, BTTS, team totals, double chance, draw-no-bet,
 * Asian handicaps and correct scores.
 *
 * The matrix is the single source of truth — every derived market is a
 * deterministic aggregation of cell probabilities, which keeps the whole
 * pricing layer consistent and auditable.
 */

import { poissonPmf, normalizeProbs, clamp } from './math';
import type { Prob3 } from '@/lib/types';

export type ScoreMatrix = number[][]; // [homeGoals][awayGoals], sums to 1

export const DEFAULT_MAX_GOALS = 12;
/** Empirical low-score correlation; fitted values typically live in [-0.15, 0). */
export const DEFAULT_RHO = -0.1;

/**
 * Independent bivariate Poisson matrix, truncated at maxGoals per side and
 * renormalized so cells sum to exactly 1 (precision below maxGoals is < 1e-9
 * for realistic λ, but exactness matters for pricing invariants).
 */
export function independentPoissonMatrix(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals: number = DEFAULT_MAX_GOALS,
): ScoreMatrix {
  const hp: number[] = [];
  const ap: number[] = [];
  for (let i = 0; i <= maxGoals; i++) {
    hp.push(poissonPmf(i, clamp(lambdaHome, 0.01, 8)));
    ap.push(poissonPmf(i, clamp(lambdaAway, 0.01, 8)));
  }
  const m: ScoreMatrix = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    m.push([]);
    for (let a = 0; a <= maxGoals; a++) {
      const p = hp[h] * ap[a];
      m[h].push(p);
      total += p;
    }
  }
  const n = normalizeProbs(m.flat());
  let k = 0;
  for (let h = 0; h <= maxGoals; h++)
    for (let a = 0; a <= maxGoals; a++) m[h][a] = n[k++];
  return m;
}

/**
 * Dixon–Coles τ adjustment for the four low-scoring cells. rho < 0 increases
 * the probability of 0-0 and 1-1 (typical empirical finding) relative to
 * independence, and adjusts 1-0 / 0-1 accordingly.
 *
 *   τ(0,0) = 1 - λh·λa·ρ     τ(1,0) = 1 + λa·ρ
 *   τ(0,1) = 1 + λh·ρ        τ(1,1) = 1 - ρ
 */
export function dixonColesAdjust(
  matrix: ScoreMatrix,
  lambdaHome: number,
  lambdaAway: number,
  rho: number = DEFAULT_RHO,
): ScoreMatrix {
  if (rho === 0) return matrix;
  const m = matrix.map((row) => [...row]);
  const tau = (x: number, y: number): number => {
    if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
    if (x === 0 && y === 1) return 1 + lambdaHome * rho;
    if (x === 1 && y === 0) return 1 + lambdaAway * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  };
  m[0][0] *= tau(0, 0);
  m[0][1] *= tau(0, 1);
  m[1][0] *= tau(1, 0);
  m[1][1] *= tau(1, 1);
  const n = normalizeProbs(m.flat());
  let k = 0;
  for (let h = 0; h < m.length; h++)
    for (let a = 0; a < m[h].length; a++) m[h][a] = n[k++];
  return m;
}

/** Full market set derived from a score matrix. All probabilities ∈ (0,1). */
export interface DerivedMarkets {
  oneXTwo: Prob3;
  doubleChance: { homeDraw: number; awayDraw: number; homeAway: number };
  drawNoBet: { home: number; away: number }; // normalized, push excluded
  overUnder: Array<{ line: number; over: number; under: number }>;
  btts: { yes: number; no: number };
  homeTotals: Array<{ line: number; over: number; under: number }>;
  awayTotals: Array<{ line: number; over: number; under: number }>;
  asianHandicapHome: Array<{
    line: number;
    cover: number; // P(home + line covers | not push)
    push: number; // P(exact push) — 0 for non-integer lines
    lose: number;
  }>;
  correctScores: Array<{ home: number; away: number; prob: number }>; // top-N
  expectedGoals: { home: number; away: number };
}

export function deriveMarkets(
  matrix: ScoreMatrix,
  opts: {
    ouLines?: number[];
    teamTotalLines?: number[];
    ahLines?: number[];
    topScores?: number;
  } = {},
): DerivedMarkets {
  const {
    ouLines = [1.5, 2.5, 3.5],
    teamTotalLines = [0.5, 1.5, 2.5],
    ahLines = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2],
    topScores = 10,
  } = opts;
  const maxG = matrix.length - 1; // square matrix

  let pHome = 0, pDraw = 0, pAway = 0;
  const pTotal: number[] = new Array(2 * maxG + 1).fill(0);
  const pHomeGoals: number[] = new Array(maxG + 1).fill(0);
  const pAwayGoals: number[] = new Array(maxG + 1).fill(0);
  let pBtts = 0, xgH = 0, xgA = 0;
  // margin distribution for Asian handicaps: margin = home - away
  const pMargin: Map<number, number> = new Map();

  const scores: Array<{ home: number; away: number; prob: number }> = [];

  for (let h = 0; h <= maxG; h++) {
    for (let a = 0; a <= maxG; a++) {
      const p = matrix[h][a];
      if (p <= 0) continue;
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      pTotal[h + a] += p;
      pHomeGoals[h] += p;
      pAwayGoals[a] += p;
      if (h > 0 && a > 0) pBtts += p;
      xgH += h * p;
      xgA += a * p;
      pMargin.set(h - a, (pMargin.get(h - a) ?? 0) + p);
      scores.push({ home: h, away: a, prob: p });
    }
  }

  const tail = (dist: ArrayLike<number>, from: number): number => {
    let s = 0;
    for (let i = Math.ceil(from); i < dist.length; i++) s += dist[i];
    return s;
  };

  const overUnder = ouLines.map((line) => {
    const over = tail(pTotal, line + 0.5); // strictly greater than line
    const under = 1 - over;
    return { line, over, under };
  });

  const teamTotals = (dist: ArrayLike<number>) =>
    teamTotalLines.map((line) => {
      const over = tail(dist, line + 0.5);
      return { line, over, under: 1 - over };
    });

  const asianHandicapHome = ahLines.map((line) => {
    // Bet on home + line. Win when margin + line > 0, push when == 0.
    let win = 0, push = 0, lose = 0;
    for (const [margin, p] of pMargin) {
      const v = margin + line;
      if (v > 0) win += p;
      else if (v === 0) push += p;
      else lose += p;
    }
    const live = win + lose;
    return {
      line,
      cover: live > 0 ? win / live : 0,
      push,
      lose: live > 0 ? lose / live : 0,
    };
  });

  scores.sort((x, y) => y.prob - x.prob);

  const dnbDenom = pHome + pAway;
  return {
    oneXTwo: { home: pHome, draw: pDraw, away: pAway },
    doubleChance: {
      homeDraw: pHome + pDraw,
      awayDraw: pAway + pDraw,
      homeAway: pHome + pAway,
    },
    drawNoBet:
      dnbDenom > 0
        ? { home: pHome / dnbDenom, away: pAway / dnbDenom }
        : { home: 0.5, away: 0.5 },
    overUnder,
    btts: { yes: pBtts, no: 1 - pBtts },
    homeTotals: teamTotals(pHomeGoals),
    awayTotals: teamTotals(pAwayGoals),
    asianHandicapHome,
    correctScores: scores.slice(0, topScores),
    expectedGoals: { home: xgH, away: xgA },
  };
}

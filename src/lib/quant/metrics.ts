/**
 * Performance metrics: prediction quality (accuracy, log loss, Brier) and
 * betting-simulation quality (ROI, yield, drawdown, streaks, volatility).
 */

import { clamp } from './math';

/** Multiclass log loss, probabilities clipped to [eps, 1]. */
export function logLossMulti(
  probRows: number[][],
  labelIdx: number[],
  eps = 1e-15,
): number {
  if (probRows.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < probRows.length; i++) {
    s += -Math.log(clamp(probRows[i][labelIdx[i]], eps, 1));
  }
  return s / probRows.length;
}

/** Multiclass Brier score: mean over rows of Σ_k (p_k − y_k)². Range [0, 2]. */
export function brierMulti(probRows: number[][], labelIdx: number[]): number {
  if (probRows.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < probRows.length; i++) {
    let r = 0;
    for (let k = 0; k < probRows[i].length; k++) {
      const y = labelIdx[i] === k ? 1 : 0;
      r += (probRows[i][k] - y) ** 2;
    }
    s += r;
  }
  return s / probRows.length;
}

export function accuracy(probRows: number[][], labelIdx: number[]): number {
  if (probRows.length === 0) return NaN;
  let ok = 0;
  for (let i = 0; i < probRows.length; i++) {
    let argmax = 0;
    for (let k = 1; k < probRows[i].length; k++)
      if (probRows[i][k] > probRows[i][argmax]) argmax = k;
    if (argmax === labelIdx[i]) ok++;
  }
  return ok / probRows.length;
}

/** A single settled selection in a betting simulation. */
export interface SettledBet {
  entryOdds: number;
  stake: number;
  pnl: number; // net profit/loss (negative of stake on loss)
  won: boolean;
  settledAt: string; // ISO timestamp — bankroll curve ordered by this
  closingOdds?: number | null;
}

export interface BettingMetrics {
  selections: number;
  wins: number;
  hitRate: number;
  totalStaked: number;
  totalPnl: number;
  roi: number; // pnl / staked
  yieldPct: number; // same as ROI, expressed for display (%)
  avgOdds: number;
  finalBankroll: number;
  bankrollSeries: Array<{ at: string; value: number }>;
  maxDrawdown: number; // absolute units
  maxDrawdownPct: number; // relative to peak
  longestLosingStreak: number;
  volatility: number; // sd of per-selection pnl
  sharpe: number; // mean(pnl)/sd(pnl), per-selection (descriptive only)
  clv: {
    samples: number;
    meanProbShift: number | null; // avg implied-prob shift vs close
    beatCloseRate: number | null; // % selections with entry > close price
  };
}

export function computeBettingMetrics(
  bets: SettledBet[],
  initialBankroll: number,
): BettingMetrics {
  const ordered = [...bets].sort((a, b) => a.settledAt.localeCompare(b.settledAt));
  const n = ordered.length;
  const wins = ordered.filter((b) => b.won).length;
  const totalStaked = ordered.reduce((a, b) => a + b.stake, 0);
  const totalPnl = ordered.reduce((a, b) => a + b.pnl, 0);

  // Bankroll curve & drawdown — computed in chronological order ONLY.
  let bank = initialBankroll;
  let peak = initialBankroll;
  let maxDd = 0;
  let maxDdPct = 0;
  const series: Array<{ at: string; value: number }> = [
    { at: ordered[0]?.settledAt ?? '', value: bank },
  ];
  let streak = 0;
  let maxStreak = 0;
  const pnls: number[] = [];
  for (const b of ordered) {
    bank += b.pnl;
    pnls.push(b.pnl);
    peak = Math.max(peak, bank);
    const dd = peak - bank;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? dd / peak : 0;
    }
    if (!b.won) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
    series.push({ at: b.settledAt, value: bank });
  }

  const meanPnl = n > 0 ? totalPnl / n : 0;
  const sdPnl =
    n > 1
      ? Math.sqrt(pnls.reduce((a, v) => a + (v - meanPnl) ** 2, 0) / (n - 1))
      : 0;

  const withClose = ordered.filter(
    (b): b is SettledBet & { closingOdds: number } =>
      typeof b.closingOdds === 'number' && b.closingOdds > 1,
  );
  const clv =
    withClose.length > 0
      ? {
          samples: withClose.length,
          meanProbShift:
            withClose.reduce(
              (a, b) => a + (1 / b.closingOdds - 1 / b.entryOdds),
              0,
            ) / withClose.length,
          beatCloseRate:
            withClose.filter((b) => b.entryOdds > b.closingOdds).length /
            withClose.length,
        }
      : { samples: 0, meanProbShift: null, beatCloseRate: null };

  return {
    selections: n,
    wins,
    hitRate: n > 0 ? wins / n : 0,
    totalStaked,
    totalPnl,
    roi: totalStaked > 0 ? totalPnl / totalStaked : 0,
    yieldPct: totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0,
    avgOdds: n > 0 ? ordered.reduce((a, b) => a + b.entryOdds, 0) / n : 0,
    finalBankroll: bank,
    bankrollSeries: series,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    longestLosingStreak: maxStreak,
    volatility: sdPnl,
    sharpe: sdPnl > 0 ? meanPnl / sdPnl : 0,
    clv,
  };
}

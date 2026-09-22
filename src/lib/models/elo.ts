/**
 * Elo rating model (spec §9).
 *
 * Ratings are updated strictly chronologically. The pre-match rating pair is
 * the only information the model may use — this is enforced by the caller
 * providing matches ordered by kickoff and never peeking ahead.
 *
 * Elo natively produces a two-outcome win expectancy. The three-way
 * distribution uses a parsimonious draw model:
 *
 *   pDraw = clamp(drawBase − drawSlope · |E − 0.5|, drawMin, drawMax)
 *   pHome = (1 − pDraw) · E
 *   pAway = (1 − pDraw) · (1 − E)
 *
 * (drawBase, drawSlope) are fitted by grid search on the TRAINING window
 * only — never on test data.
 */

import { clamp } from '@/lib/quant/math';
import { logLossMulti } from '@/lib/quant/metrics';
import type { Prob3, MatchResult3 } from '@/lib/types';

export interface EloParams {
  kBase: number; // base K factor
  goalFactor: boolean; // scale K by goal difference
  homeAdvantage: number; // Elo points added to home rating for expectancy
  newTeamRating: number;
  drawBase: number;
  drawSlope: number;
}

export const DEFAULT_ELO_PARAMS: EloParams = {
  kBase: 32,
  goalFactor: true,
  homeAdvantage: 65,
  newTeamRating: 1500,
  drawBase: 0.28,
  drawSlope: 0.18,
};

export interface EloRatedMatch {
  homeTeamId: number;
  awayTeamId: number;
  result: MatchResult3;
  homeGoals: number;
  awayGoals: number;
  kickoff: string; // ISO — must be processed in ascending order
}

/** Pre-match rating snapshot attached to each processed match. */
export interface EloSnapshot extends EloRatedMatch {
  homeRatingPre: number;
  awayRatingPre: number;
  kUsed: number;
}

export class EloSystem {
  private ratings = new Map<number, number>();
  constructor(public readonly params: EloParams = DEFAULT_ELO_PARAMS) {}

  rating(teamId: number): number {
    return this.ratings.get(teamId) ?? this.params.newTeamRating;
  }

  /** Expected home score (excluding draws): 1 / (1 + 10^(-dr/400)). */
  expectedHome(homeId: number, awayId: number): number {
    const dr =
      this.rating(homeId) + this.params.homeAdvantage - this.rating(awayId);
    return 1 / (1 + Math.pow(10, -dr / 400));
  }

  private kFactor(goalDiff: number): number {
    const k = this.params.kBase;
    if (!this.params.goalFactor || goalDiff <= 1) return k;
    if (goalDiff === 2) return k * 1.5;
    if (goalDiff === 3) return k * 1.75;
    return k * (2.0 - 0.05 * (goalDiff - 4));
  }

  /** Apply one match result. Returns pre-match ratings for auditability. */
  update(m: EloRatedMatch): EloSnapshot {
    const homePre = this.rating(m.homeTeamId);
    const awayPre = this.rating(m.awayTeamId);
    const e = this.expectedHome(m.homeTeamId, m.awayTeamId);
    const sHome = m.result === 'H' ? 1 : m.result === 'D' ? 0.5 : 0;
    const k = this.kFactor(Math.abs(m.homeGoals - m.awayGoals));
    const delta = k * (sHome - e);
    this.ratings.set(m.homeTeamId, homePre + delta);
    this.ratings.set(m.awayTeamId, awayPre - delta);
    return { ...m, homeRatingPre: homePre, awayRatingPre: awayPre, kUsed: k };
  }

  /**
   * Replay a chronological slice of matches, returning pre-match snapshots.
   * Ratings are MUTATED — construct a fresh EloSystem per replay.
   */
  replayOrdered(matches: EloRatedMatch[]): EloSnapshot[] {
    return matches.map((m) => this.update(m));
  }

  /** Current three-way probabilities from ratings only. */
  threeWay(homeId: number, awayId: number): Prob3 {
    const e = this.expectedHome(homeId, awayId);
    const pDraw = clamp(
      this.params.drawBase - this.params.drawSlope * Math.abs(e - 0.5),
      0.08,
      0.38,
    );
    return {
      home: (1 - pDraw) * e,
      draw: pDraw,
      away: (1 - pDraw) * (1 - e),
    };
  }
}

export function eloThreeWayFromRatings(
  homeRating: number,
  awayRating: number,
  params: EloParams,
): Prob3 {
  const dr = homeRating + params.homeAdvantage - awayRating;
  const e = 1 / (1 + Math.pow(10, -dr / 400));
  const pDraw = clamp(
    params.drawBase - params.drawSlope * Math.abs(e - 0.5),
    0.08,
    0.38,
  );
  return {
    home: (1 - pDraw) * e,
    draw: pDraw,
    away: (1 - pDraw) * (1 - e),
  };
}

/**
 * Fit (drawBase, drawSlope) by deterministic grid search over the training
 * window's pre-match snapshots. Returns the best (lowest log loss) params.
 */
export function fitDrawParams(
  snapshots: EloSnapshot[],
  base: EloParams = DEFAULT_ELO_PARAMS,
): EloParams {
  if (snapshots.length < 50) return base;
  const labels = snapshots.map((s) => (s.result === 'H' ? 0 : s.result === 'D' ? 1 : 2));
  let best: EloParams = base;
  let bestLoss = Infinity;
  for (let drawBase = 0.18; drawBase <= 0.34; drawBase += 0.02) {
    for (let drawSlope = 0; drawSlope <= 0.4; drawSlope += 0.05) {
      const params = { ...base, drawBase, drawSlope };
      const rows = snapshots.map((s) => {
        const p = eloThreeWayFromRatings(s.homeRatingPre, s.awayRatingPre, params);
        return [p.home, p.draw, p.away];
      });
      const loss = logLossMulti(rows, labels);
      if (loss < bestLoss) {
        bestLoss = loss;
        best = params;
      }
    }
  }
  return best;
}

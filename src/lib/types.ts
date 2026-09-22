/**
 * Shared domain types. These mirror the database schema and are the contract
 * between the quant engine, services, API routes and UI.
 */

export type MatchResult3 = 'H' | 'D' | 'A';

export interface Prob3 {
  home: number;
  draw: number;
  away: number;
}

export function prob3ToArray(p: Prob3): [number, number, number] {
  return [p.home, p.draw, p.away];
}

export function labelIndex(r: MatchResult3): 0 | 1 | 2 {
  return r === 'H' ? 0 : r === 'D' ? 1 : 2;
}

export type MatchStatus =
  | 'SCHEDULED'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELLED';

export type QualityStatus = 'VALID' | 'WARNING' | 'INVALID';

export type OddsKind = 'OPEN' | 'MID' | 'CLOSE';

export type ExperimentStatus =
  | 'UNTESTED'
  | 'PROMISING'
  | 'VALIDATING'
  | 'PASSED'
  | 'REJECTED'
  | 'RETIRED';

export type EdgeStatus = ExperimentStatus;

export type ModelKind =
  | 'ELO'
  | 'POISSON'
  | 'LOGISTIC'
  | 'GBM'
  | 'ENSEMBLE';

export type Role = 'reader' | 'researcher' | 'admin';

/** Canonical market codes. Line-bearing markets additionally carry a `line`. */
export const MARKET = {
  ONE_X_TWO: 'ONE_X_TWO',
  DOUBLE_CHANCE: 'DOUBLE_CHANCE',
  DRAW_NO_BET: 'DRAW_NO_BET',
  OU_GOALS: 'OU_GOALS',
  BTTS: 'BTTS',
  TEAM_TOTALS: 'TEAM_TOTALS',
  ASIAN_HANDICAP: 'ASIAN_HANDICAP',
  CORRECT_SCORE: 'CORRECT_SCORE',
} as const;

export type MarketCode = (typeof MARKET)[keyof typeof MARKET];

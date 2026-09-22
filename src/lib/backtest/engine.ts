/**
 * Walk-forward backtesting engine (spec §18/§19).
 *
 * Chronological integrity protocol — NON-NEGOTIABLE:
 *   1. Test matches are consumed in strictly ascending kickoff order.
 *   2. At each refit point T (round boundary), ALL model components are
 *      trained exclusively on rows with kickoff < T (see models/pipeline.ts
 *      for the train/validation hold-out scheme).
 *   3. Predictions for matches in [T, next refit) come only from those
 *      models; no model object ever sees a test match's result before
 *      predicting it.
 *   4. Entry prices: the latest bookmaker snapshot at or before
 *      kickoff − entryCutoffMinutes. Closing prices are used only for
 *      CLV diagnostics, attached after settlement.
 *   5. NOTHING is randomly shuffled. Splits are chronological.
 *
 * The engine is deterministic: identical database + config ⇒ identical run.
 */

import type { Db } from '@/lib/db/client';
import {
  finishedBefore,
  bestEntryPrice,
  consensusEntryPrice,
  closingPrice,
  marketDefMap,
  matchById,
  type MatchRow,
} from '@/lib/db/repos-core';
import {
  fitEnsembleAt,
  predictFixture,
  DEFAULT_PIPELINE_CONFIG,
  type PipelineConfig,
  type FittedEnsemble,
} from '@/lib/models/pipeline';
import { assessDisagreement } from '@/lib/quant/uncertainty';
import { expectedValue, fairOdds } from '@/lib/quant/pricing';
import {
  computeBettingMetrics,
  logLossMulti,
  brierMulti,
  accuracy,
  type SettledBet,
} from '@/lib/quant/metrics';
import { calibrationReport, type CalibrationReport } from '@/lib/quant/calibration';
import { prob3ToArray } from '@/lib/types';
import { hashSeed } from '@/lib/quant/random';

export interface BacktestMarketSpec {
  code: 'ONE_X_TWO' | 'OU_GOALS';
  line?: number; // required for OU_GOALS
}

export interface MatchFilterSpec {
  /** a feature from FeatureBuilder's FEATURE_NAMES */
  feature: string;
  op: '>=' | '<=' | 'between';
  value: number;
  value2?: number;
}

export interface BacktestConfig {
  name: string;
  competitionId?: number | null;
  testFrom: string; // ISO — first test kickoff boundary
  testTo: string; // ISO — end (exclusive)
  refitEveryRounds: number;
  pipeline: PipelineConfig;
  markets: BacktestMarketSpec[];
  edgeMin: number; // minimum calibrated EV to select
  probMin: number; // ignore longshot tails below this probability
  probMax: number; // ignore near-certainties above this probability
  skipWhenSplit: boolean; // model-disagreement filter
  /**
   * Optional pre-match feature conditions (experiments only). Every
   * condition is evaluated on the LEAKAGE-SAFE pre-match snapshot — never
   * on anything later — so filtered strategies remain honest.
   */
  matchFilterSpec?: MatchFilterSpec[];
  entryPrice: 'best' | 'consensus';
  entryCutoffMinutes: number; // information horizon buffer before kickoff
  stakeMode: 'flat' | 'kelly';
  stakeFlat: number;
  kellyFraction: number;
  maxStakePctBankroll: number;
  initialBankroll: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  name: 'Standard walk-forward — 1X2 & O/U 2.5',
  competitionId: null,
  testFrom: '',
  testTo: '',
  refitEveryRounds: 3,
  pipeline: DEFAULT_PIPELINE_CONFIG,
  markets: [
    { code: 'ONE_X_TWO' },
    { code: 'OU_GOALS', line: 2.5 },
  ],
  edgeMin: 0.04,
  probMin: 0.15,
  probMax: 0.92,
  skipWhenSplit: false,
  entryPrice: 'best',
  entryCutoffMinutes: 60,
  stakeMode: 'flat',
  stakeFlat: 1,
  kellyFraction: 0.25,
  maxStakePctBankroll: 0.03,
  initialBankroll: 1000,
};

export interface SelectionDecision {
  matchId: number;
  kickoff: string;
  market: string;
  line: number | null;
  selection: string;
  modelProbability: number;
  fair: number;
  entryOdds: number;
  bookmaker: string | null;
  ev: number;
  closingOdds: number | null;
  won: boolean;
  asOf: string;
  probsJson: string;
}

export interface BacktestOutput {
  config: BacktestConfig;
  refits: number;
  testMatches: number;
  predictions: { probRows: number[][]; labels: number[] };
  selections: SelectionDecision[];
  bets: SettledBet[];
  metrics: ReturnType<typeof computeBettingMetrics>;
  predictionMetrics: { logLoss: number; brier: number; accuracy: number };
  calibration: CalibrationReport;
  disagreementSkipCount: number;
  oddsMissingCount: number;
  fingerprint: string;
}

interface ProgressState {
  phase: string;
  done: number;
  total: number;
  updatedAt: string;
}

const progressRegistry = new Map<number, ProgressState>();

export function backtestProgress(runId: number): ProgressState | null {
  return progressRegistry.get(runId) ?? null;
}

function setProgress(runId: number, p: ProgressState): void {
  progressRegistry.set(runId, { ...p, updatedAt: new Date().toISOString() });
}

function roundKey(m: MatchRow): string {
  return `${m.competition_id}|${m.round}`;
}

export interface RunnerHooks {
  registerModelVersion?: (fingerprint: string, cfg: BacktestConfig) => number;
}

/**
 * Execute a walk-forward backtest against the database. Throws on invalid
 * configuration; callers persist the run row + output metrics.
 */
export function executeBacktest(
  db: Db,
  cfg: BacktestConfig,
  progressKey: number = 0,
): BacktestOutput {
  if (Date.parse(cfg.testFrom) >= Date.parse(cfg.testTo)) {
    throw new Error('BacktestConfig: testFrom must be before testTo');
  }
  const testMatches = finishedBefore(db, cfg.testTo, {
    competitionId: cfg.competitionId ?? undefined,
    from: cfg.testFrom,
  });
  if (testMatches.length < 20) {
    throw new Error(
      `BacktestConfig: only ${testMatches.length} test matches in [${cfg.testFrom}, ${cfg.testTo}) — need ≥ 20.`,
    );
  }

  // chronological round groups, ordered by first kickoff
  const groups = new Map<string, MatchRow[]>();
  for (const m of testMatches) {
    const k = roundKey(m);
    const arr = groups.get(k) ?? [];
    arr.push(m);
    groups.set(k, arr);
  }
  const orderedGroups = [...groups.values()].sort((a, b) =>
    a[0].kickoff_utc.localeCompare(b[0].kickoff_utc),
  );

  const marketDefs = marketDefMap(db);
  const ouLine = cfg.markets.find((m) => m.code === 'OU_GOALS')?.line ?? null;
  const ouMarketId =
    ouLine != null ? marketDefs.get(`OU_GOALS|${ouLine}`)?.id ?? null : null;
  const oneXTwoId = marketDefs.get('ONE_X_TWO|null')?.id ?? null;
  if (cfg.markets.some((m) => m.code === 'ONE_X_TWO') && oneXTwoId == null) {
    throw new Error('Backtest: ONE_X_TWO market definition missing from database');
  }
  if (cfg.markets.some((m) => m.code === 'OU_GOALS') && ouMarketId == null) {
    throw new Error(`Backtest: OU_GOALS line ${ouLine} market definition missing`);
  }

  const probRows: number[][] = [];
  const labels: number[] = [];
  const selections: SelectionDecision[] = [];
  const bets: SettledBet[] = [];
  let fitted: FittedEnsemble | null = null;
  let refits = 0;
  let disagreementSkips = 0;
  let oddsMissing = 0;
  let processedMatches = 0;

  for (let gi = 0; gi < orderedGroups.length; gi++) {
    const group = orderedGroups[gi];
    const groupStart = group[0].kickoff_utc;
    if (gi % Math.max(1, cfg.refitEveryRounds) === 0 || fitted === null) {
      setProgress(progressKey, {
        phase: `fitting models (round group ${gi + 1}/${orderedGroups.length}, as-of ${groupStart.slice(0, 10)})`,
        done: processedMatches,
        total: testMatches.length,
        updatedAt: '',
      });
      fitted = fitEnsembleAt(db, groupStart, cfg.pipeline, {
        competitionId: cfg.competitionId ?? undefined,
      });
      refits++;
    }

    for (const m of group) {
      setProgress(progressKey, {
        phase: 'predicting & settling',
        done: ++processedMatches,
        total: testMatches.length,
        updatedAt: '',
      });
      const pred = predictFixture(fitted, m);
      const arr = prob3ToArray(pred.ensemble);
      const label = m.home_goals! > m.away_goals! ? 0 : m.home_goals! === m.away_goals! ? 1 : 2;
      probRows.push(arr);
      labels.push(label);

      const entryAsOf = new Date(
        Date.parse(m.kickoff_utc) - cfg.entryCutoffMinutes * 60_000,
      ).toISOString();

      const disagreement = assessDisagreement([
        { kind: 'ELO', probs: pred.perModel.ELO },
        { kind: 'POISSON', probs: pred.perModel.POISSON },
        { kind: 'LOGISTIC', probs: pred.perModel.LOGISTIC },
        { kind: 'GBM', probs: pred.perModel.GBM },
      ]);
      if (cfg.skipWhenSplit && disagreement.label === 'SPLIT') {
        disagreementSkips++;
        continue;
      }
      // experiment-scoped conditional strategies: pre-match features only
      if (cfg.matchFilterSpec) {
        const byName = pred.snapshot.byName as Record<string, number>;
        const pass = cfg.matchFilterSpec.every((f) => {
          const v = byName[f.feature] ?? 0;
          if (f.op === '>=') return v >= f.value;
          if (f.op === '<=') return v <= f.value;
          return v >= f.value && v <= (f.value2 ?? f.value);
        });
        if (!pass) continue;
      }

      type Candidate = {
        market: string;
        line: number | null;
        selection: string;
        prob: number;
        marketId: number;
        won: boolean;
      };
      const candidates: Candidate[] = [];
      if (cfg.markets.some((mk) => mk.code === 'ONE_X_TWO') && oneXTwoId != null) {
        candidates.push(
          { market: 'ONE_X_TWO', line: null, selection: 'HOME', prob: arr[0], marketId: oneXTwoId, won: label === 0 },
          { market: 'ONE_X_TWO', line: null, selection: 'DRAW', prob: arr[1], marketId: oneXTwoId, won: label === 1 },
          { market: 'ONE_X_TWO', line: null, selection: 'AWAY', prob: arr[2], marketId: oneXTwoId, won: label === 2 },
        );
      }
      if (ouMarketId != null && ouLine != null) {
        const ou = pred.markets.overUnder.find((o) => o.line === ouLine);
        if (ou) {
          const totalGoals = m.home_goals! + m.away_goals!;
          candidates.push(
            { market: 'OU_GOALS', line: ouLine, selection: 'OVER', prob: ou.over, marketId: ouMarketId, won: totalGoals > ouLine },
            { market: 'OU_GOALS', line: ouLine, selection: 'UNDER', prob: ou.under, marketId: ouMarketId, won: totalGoals < ouLine },
          );
        }
      }

      for (const c of candidates) {
        if (c.prob < cfg.probMin || c.prob > cfg.probMax) continue;
        const price =
          cfg.entryPrice === 'best'
            ? bestEntryPrice(db, m.id, c.marketId, c.selection, entryAsOf)
            : consensusEntryPrice(db, m.id, c.marketId, c.selection, entryAsOf);
        if (!price) {
          oddsMissing++;
          continue;
        }
        const ev = expectedValue(c.prob, price.odds);
        if (ev < cfg.edgeMin) continue;
        const close = closingPrice(db, m.id, c.marketId, c.selection);
        selections.push({
          matchId: m.id,
          kickoff: m.kickoff_utc,
          market: c.market,
          line: c.line,
          selection: c.selection,
          modelProbability: c.prob,
          fair: fairOdds(c.prob),
          entryOdds: price.odds,
          bookmaker: 'bookmakerId' in price ? `book#${price.bookmakerId}` : 'consensus',
          ev,
          closingOdds: close,
          won: c.won,
          asOf: entryAsOf,
          probsJson: JSON.stringify({
            ensemble: pred.ensemble,
            perModel: pred.perModel,
            weights: fitted.weights,
            agreement: disagreement.label,
          }),
        });
      }
    }
  }

  // stakes on a running bankroll, in settlement (kickoff) order
  let bankroll = cfg.initialBankroll;
  for (const s of selections) {
    let stake: number;
    if (cfg.stakeMode === 'kelly') {
      const kellyF = Math.max(0, (s.entryOdds * s.modelProbability - 1) / (s.entryOdds - 1));
      stake = Math.min(
        cfg.maxStakePctBankroll * bankroll,
        cfg.kellyFraction * kellyF * bankroll,
      );
    } else {
      stake = cfg.stakeFlat;
    }
    stake = Math.round(stake * 100) / 100;
    const pnl = s.won ? stake * (s.entryOdds - 1) : -stake;
    bankroll += pnl;
    bets.push({
      entryOdds: s.entryOdds,
      stake,
      pnl: Math.round(pnl * 100) / 100,
      won: s.won,
      settledAt: s.kickoff,
      closingOdds: s.closingOdds,
    });
  }

  const metrics = computeBettingMetrics(bets, cfg.initialBankroll);
  const predictionMetrics = {
    logLoss: logLossMulti(probRows, labels),
    brier: brierMulti(probRows, labels),
    accuracy: accuracy(probRows, labels),
  };
  const calibration = calibrationReport(probRows, labels);

  const fingerprint = `bt-${hashSeed(
    JSON.stringify(cfg),
    testMatches[0].kickoff_utc,
    testMatches[testMatches.length - 1].kickoff_utc,
    testMatches.length,
    selections.length,
    Math.round(metrics.totalPnl * 100),
  ).toString(16)}`;

  return {
    config: cfg,
    refits,
    testMatches: testMatches.length,
    predictions: { probRows, labels },
    selections,
    bets,
    metrics,
    predictionMetrics,
    calibration,
    disagreementSkipCount: disagreementSkips,
    oddsMissingCount: oddsMissing,
    fingerprint,
  };
}

/** Convenience: persist a finished backtest's selections via the repos. */
export function selectionMarketId(
  db: Db,
  s: SelectionDecision,
): number | null {
  const defs = marketDefMap(db);
  const key = `${s.market}|${s.line ?? 'null'}`;
  return defs.get(key)?.id ?? null;
}

export { matchById };

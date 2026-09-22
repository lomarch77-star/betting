/**
 * Research Lab service (spec §21) — creates experiments, executes them as
 * scoped walk-forward backtests, persists metrics and assigns an honest
 * status. A positive historical ROI alone NEVER earns "PASSED": status
 * requires sample sufficiency AND calibration sanity; final promotion is a
 * human decision (edge registry).
 */

import type { Db } from '@/lib/db/client';
import {
  insertExperiment,
  updateExperimentResult,
  experimentById,
  audit,
} from '@/lib/db/repos-research';
import { executeBacktest, type BacktestConfig, type MatchFilterSpec } from '@/lib/backtest/engine';
import { runBacktestAsync } from './backtestService';
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models/pipeline';

export interface ExperimentConfig {
  dataset: {
    competitionId: number | null;
    testFrom: string;
    testTo: string;
    trainSpanDays: number;
  };
  market: 'ONE_X_TWO' | 'OU_GOALS';
  line?: number;
  matchFilters?: MatchFilterSpec[];
  methodology: {
    refitEveryRounds: number;
    edgeMin: number;
    entryPrice: 'best' | 'consensus';
    calibrationMethod: 'platt' | 'isotonic';
  };
}

export function createExperiment(
  db: Db,
  input: { title: string; hypothesis: string; config: ExperimentConfig; createdBy?: string },
): number {
  const id = insertExperiment(db, {
    title: input.title,
    hypothesis: input.hypothesis,
    config_json: JSON.stringify(input.config),
    created_by: input.createdBy ?? 'researcher',
  });
  audit(db, {
    actor: input.createdBy ?? 'researcher',
    role: 'researcher',
    action: 'CREATE_EXPERIMENT',
    entity: 'experiment',
    entity_id: id,
  });
  return id;
}

function experimentToBacktestConfig(
  db: Db,
  exp: { title: string; config: ExperimentConfig },
  runId: number,
): BacktestConfig {
  const c = exp.config;
  return {
    name: `EXP-${String(runId).padStart(4, '0')} — ${exp.title}`,
    competitionId: c.dataset.competitionId,
    testFrom: c.dataset.testFrom,
    testTo: c.dataset.testTo,
    refitEveryRounds: c.methodology.refitEveryRounds,
    pipeline: {
      ...DEFAULT_PIPELINE_CONFIG,
      trainSpanDays: c.dataset.trainSpanDays,
      calibrationMethod: c.methodology.calibrationMethod,
    },
    markets: [{ code: c.market, ...(c.line != null ? { line: c.line } : {}) } as never],
    matchFilterSpec: c.matchFilters,
    edgeMin: c.methodology.edgeMin,
    probMin: 0.15,
    probMax: 0.92,
    skipWhenSplit: false,
    entryPrice: c.methodology.entryPrice,
    entryCutoffMinutes: 60,
    stakeMode: 'flat',
    stakeFlat: 1,
    kellyFraction: 0.25,
    maxStakePctBankroll: 0.03,
    initialBankroll: 1000,
  };
}

/**
 * Execute an experiment synchronously. Honest status rules:
 *   sample < 30                          → UNTESTED (insufficient evidence)
 *   roi > 0 AND calibration sane         → PROMISING (deserves validation)
 *   roi ≤ −2%                            → REJECTED
 *   else                                 → VALIDATING (inconclusive)
 */
export function runExperiment(db: Db, experimentId: number, actor = 'researcher'): {
  status: string;
  metrics: ReturnType<typeof summarize>;
} {
  const exp = experimentById(db, experimentId);
  if (!exp) throw new Error(`No experiment ${experimentId}`);
  const config = JSON.parse(exp.config_json) as ExperimentConfig;
  const cfg = experimentToBacktestConfig(db, { title: exp.title, config }, experimentId);
  const out = executeBacktest(db, cfg, -experimentId);

  const metrics = summarize(out);
  const n = metrics.betting.selections;
  let status: 'UNTESTED' | 'PROMISING' | 'REJECTED' | 'VALIDATING';
  let resultText: string;
  if (n < 30) {
    status = 'UNTESTED';
    resultText = `Insufficient selections (${n}) for evaluation. Widen the dataset or conditions; no conclusion drawn.`;
  } else if (metrics.betting.roi > 0 && metrics.calibration.ece <= 0.08) {
    status = 'PROMISING';
    resultText = `Positive OOS ROI (${(metrics.betting.roi * 100).toFixed(1)}%) on ${n} selections with acceptable calibration (ECE ${metrics.calibration.ece.toFixed(3)}). Hypothesis earns extended validation — this is NOT proof of edge.`;
  } else if (metrics.betting.roi <= -0.02) {
    status = 'REJECTED';
    resultText = `OOS ROI ${(metrics.betting.roi * 100).toFixed(1)}% on ${n} selections. Hypothesis rejected at current specification.`;
  } else {
    status = 'VALIDATING';
    resultText = `Inconclusive: ROI ${(metrics.betting.roi * 100).toFixed(1)}% on ${n} selections. Extend the OOS window before judging.`;
  }

  updateExperimentResult(db, experimentId, status, JSON.stringify(metrics), resultText);
  audit(db, {
    actor,
    role: 'researcher',
    action: 'RUN_EXPERIMENT',
    entity: 'experiment',
    entity_id: experimentId,
    detail: { status, selections: n, roi: metrics.betting.roi },
  });
  return { status, metrics };
}

function summarize(out: ReturnType<typeof executeBacktest>) {
  return {
    testMatches: out.testMatches,
    refits: out.refits,
    fingerprint: out.fingerprint,
    prediction: out.predictionMetrics,
    calibration: {
      sample: out.calibration.sample,
      logLoss: out.calibration.logLoss,
      brier: out.calibration.brier,
      ece: out.calibration.ece,
    },
    betting: {
      selections: out.metrics.selections,
      hitRate: out.metrics.hitRate,
      roi: out.metrics.roi,
      totalStaked: out.metrics.totalStaked,
      totalPnl: out.metrics.totalPnl,
      avgOdds: out.metrics.avgOdds,
      maxDrawdownPct: out.metrics.maxDrawdownPct,
      longestLosingStreak: out.metrics.longestLosingStreak,
      volatility: out.metrics.volatility,
      clv: out.metrics.clv,
    },
  };
}

/** Fire-and-forget experiment → status transitions handled inside. */
export function runExperimentAsync(db: Db, experimentId: number, actor = 'researcher'): void {
  setImmediate(() => {
    try {
      runExperiment(db, experimentId, actor);
    } catch (err) {
      updateExperimentResult(
        db,
        experimentId,
        'REJECTED',
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        'Experiment failed to execute — check configuration.',
      );
    }
  });
}

export { runBacktestAsync };

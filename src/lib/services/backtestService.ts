/**
 * Backtest service — runs walk-forward backtests (synchronous, in-process),
 * persists run rows, selections and the model version, and exposes progress
 * for the UI. A run is a background job from the app's perspective: the
 * route returns immediately and the UI polls status.
 */

import type { Db } from '@/lib/db/client';
import { tx, nowIso } from '@/lib/db/client';
import { listSeasons } from '@/lib/db/repos-core';
import {
  insertBacktestRun,
  finishBacktestRun,
  insertBacktestSelections,
  insertModelVersion,
  insertEdge,
  updateEdge,
  listEdges,
  audit,
} from '@/lib/db/repos-research';
import {
  executeBacktest,
  selectionMarketId,
  backtestProgress,
  DEFAULT_BACKTEST_CONFIG,
  type BacktestConfig,
  type BacktestOutput,
} from '@/lib/backtest/engine';
import { hashSeed } from '@/lib/quant/random';

const runningJobs = new Set<number>();

export { backtestProgress };

/** Default config: test over the most recent completed season + current partial. */
export function defaultBacktestConfig(db: Db): BacktestConfig {
  const seasons = listSeasons(db).filter((s) => s.competition_id === 1);
  const finishedSeasons = seasons.filter((s) => s.status === 'FINISHED');
  const lastFinished = finishedSeasons[finishedSeasons.length - 1];
  const testFrom = lastFinished?.start_date ?? '2025-08-01T00:00:00Z';
  const testTo = new Date().toISOString();
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    name: `Standard walk-forward — test ${lastFinished?.code ?? 'recent'} + current season`,
    testFrom,
    testTo,
  };
}

function persistOutput(db: Db, runId: number, out: BacktestOutput): void {
  tx(db, () => {
    const versionId = insertModelVersion(db, {
      code: `ensemble-bt-${runId}-${out.fingerprint}`,
      kind: 'ENSEMBLE',
      name: `Backtest ensemble — run BT-${String(runId).padStart(4, '0')}`,
      config_json: JSON.stringify(out.config),
      train_window_from: out.config.testFrom,
      train_window_to: out.config.testTo,
      train_sample: out.testMatches,
      dataset_fingerprint: out.fingerprint,
    });
    const rows = out.selections.map((s, i) => ({
      run_id: runId,
      match_id: s.matchId,
      market_id: selectionMarketId(db, s)!,
      selection: s.selection,
      model_probability: s.modelProbability,
      fair_odds: s.fair,
      entry_odds: s.entryOdds,
      closing_odds: s.closingOdds,
      bookmaker: s.bookmaker,
      ev: s.ev,
      stake: out.bets[i].stake,
      won: s.won,
      pnl: out.bets[i].pnl,
      settled_at: s.kickoff,
      as_of: s.asOf,
      predicted_probs_json: s.probsJson,
    }));
    insertBacktestSelections(db, rows);
    const metricsJson = JSON.stringify({
      fingerprint: out.fingerprint,
      refits: out.refits,
      testMatches: out.testMatches,
      prediction: out.predictionMetrics,
      calibration: {
        sample: out.calibration.sample,
        logLoss: out.calibration.logLoss,
        brier: out.calibration.brier,
        ece: out.calibration.ece,
        binsPerClass: out.calibration.binsPerClass,
      },
      betting: out.metrics,
      diagnostics: {
        disagreementSkips: out.disagreementSkipCount,
        oddsMissing: out.oddsMissingCount,
      },
      modelVersionId: versionId,
    });
    finishBacktestRun(db, runId, 'COMPLETE', metricsJson, null);
    db.prepare('UPDATE backtest_runs SET model_version_id = ? WHERE id = ?').run(versionId, runId);
  });
}

/**
 * Run a backtest synchronously (blocking ~10–90s depending on window).
 * The API route wraps this in setImmediate and returns the run id.
 */
export function runBacktestSync(db: Db, cfg: BacktestConfig, actor = 'system'): number {
  const runId = insertBacktestRun(db, {
    name: cfg.name,
    config_json: JSON.stringify(cfg),
  });
  audit(db, { actor, role: 'researcher', action: 'RUN_BACKTEST', entity: 'backtest_run', entity_id: runId, detail: { testFrom: cfg.testFrom, testTo: cfg.testTo } });
  runningJobs.add(runId);
  try {
    const out = executeBacktest(db, cfg, runId);
    persistOutput(db, runId, out);
  } catch (err) {
    finishBacktestRun(db, runId, 'FAILED', null, err instanceof Error ? err.message : String(err));
  } finally {
    runningJobs.delete(runId);
  }
  return runId;
}

export function isBacktestRunning(runId: number): boolean {
  return runningJobs.has(runId);
}

/** Fire-and-forget wrapper used by the API and startup. */
export function runBacktestAsync(db: Db, cfg: BacktestConfig, actor = 'system'): number {
  const runId = insertBacktestRun(db, {
    name: cfg.name,
    config_json: JSON.stringify(cfg),
  });
  audit(db, { actor, role: 'researcher', action: 'RUN_BACKTEST', entity: 'backtest_run', entity_id: runId, detail: { testFrom: cfg.testFrom, testTo: cfg.testTo } });
  runningJobs.add(runId);
  setImmediate(() => {
    try {
      const out = executeBacktest(db, cfg, runId);
      persistOutput(db, runId, out);
    } catch (err) {
      finishBacktestRun(db, runId, 'FAILED', null, err instanceof Error ? err.message : String(err));
    } finally {
      runningJobs.delete(runId);
    }
  });
  return runId;
}

// ─── Seed edges (registry demonstration with real, reproducible runs) ───────

export const SEEDED_EDGES_FLAG = 'seeded_edges_v1';

/** Create + validate a demonstration edge via a real scoped backtest. */
export function seedEdgeFromRun(
  db: Db,
  e: {
    title: string;
    market_code: string;
    hypothesis: string;
    experimentId: number | null;
    trainingPeriod: string;
    validationPeriod: string;
    oosPeriod: string;
    metrics: Record<string, unknown>;
    sample: number;
    status: 'VALIDATING' | 'PROMISING' | 'REJECTED';
  },
): number {
  const existing = listEdges(db).find((x) => x.title === e.title);
  if (existing) return existing.id;
  return insertEdge(db, {
    title: e.title,
    market_code: e.market_code,
    hypothesis: e.hypothesis,
    experiment_id: e.experimentId,
    training_period: e.trainingPeriod,
    validation_period: e.validationPeriod,
    oos_period: e.oosPeriod,
    sample_size: e.sample,
    metrics_json: JSON.stringify(e.metrics),
    status: e.status,
  });
}

export { updateEdge };

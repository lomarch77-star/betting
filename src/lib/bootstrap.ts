/**
 * Application bootstrap — makes the app self-contained: first request (or
 * server start) ensures the DB exists, seeds the deterministic demo universe,
 * runs data-quality checks, fits the standard ensemble, predicts upcoming
 * fixtures, and kicks off the default walk-forward backtest in the
 * background. Idempotent; seeded state survives restarts.
 */

import { getDb } from '@/lib/db/client';
import { listBacktestRuns, getSetting, setSetting, listEdges } from '@/lib/db/repos-research';
import { latestDqReport } from '@/lib/db/repos-research';
import { seedDemoUniverse } from '@/lib/data/seed';
import { runDataQualityChecks } from '@/lib/services/dqService';
import {
  standardEnsemble,
  predictUpcoming,
  invalidateStandardCache,
} from '@/lib/services/predictionService';
import {
  runBacktestAsync,
  defaultBacktestConfig,
  seedEdgeFromRun,
} from '@/lib/services/backtestService';
import { createExperiment, runExperiment } from '@/lib/services/experimentService';
import { settleDueEntries } from '@/lib/services/portfolioService';

let state: 'idle' | 'booting' | 'ready' = 'idle';

export function bootstrapStatus(): string {
  return state;
}

export function ensureBootstrapped(): void {
  if (state !== 'idle') return;
  state = 'booting';
  try {
    const db = getDb();
    const seedResult = seedDemoUniverse(db);
    if (!latestDqReport(db)) {
      runDataQualityChecks(db);
    }
    settleDueEntries(db);

    // heavy work detached so the first request stays fast
    setImmediate(() => {
      void (async () => {
        try {
          invalidateStandardCache();
          await standardEnsemble(db);
          await predictUpcoming(db);
        } catch (err) {
          console.error('[bootstrap] prediction pipeline failed:', err);
        }
        try {
          if (listBacktestRuns(db).length === 0) {
            runBacktestAsync(db, defaultBacktestConfig(db), 'system');
          }
          seedResearchDefaults(db);
        } catch (err) {
          console.error('[bootstrap] research defaults failed:', err);
        }
        state = 'ready';
      })();
    });
  } catch (err) {
    state = 'idle'; // allow retry on next request
    throw err;
  }
  void seedDemoUniverse;
}

/**
 * Demonstration research content — registered ONCE (flagged) with real,
 * reproducible scoped experiments so edges point to actual evidence.
 */
function seedResearchDefaults(db: ReturnType<typeof getDb>): void {
  if (getSetting(db, 'bootstrap_research_v1') === 'done') return;
  if (listEdges(db).length > 0) {
    setSetting(db, 'bootstrap_research_v1', 'done');
    return;
  }

  const experiments = [
    {
      title: 'High combined goal expectancy → Over 2.5',
      hypothesis:
        'Fixtures whose rolling, opponent-adjusted attack/defence matchups indicate elevated combined scoring rates produce a higher probability of Over 2.5 than market prices imply.',
      config: {
        dataset: {
          competitionId: null,
          testFrom: twoSeasonsAgo(db),
          testTo: new Date().toISOString(),
          trainSpanDays: 760,
        },
        market: 'OU_GOALS' as const,
        line: 2.5,
        matchFilters: [{ feature: 'combinedGoalExpectancy', op: '>=' as const, value: 0.42 }],
        methodology: {
          refitEveryRounds: 4,
          edgeMin: 0.01,
          entryPrice: 'best' as const,
          calibrationMethod: 'isotonic' as const,
        },
      },
      edgeMarket: 'Over/Under 2.5',
      edgeTitle: 'Combined goal-expectancy → Over 2.5',
    },
    {
      title: 'Large Elo gap + rest advantage → home strength underestimated',
      hypothesis:
        'Home favourites (Elo gap ≥ 90) with a rest advantage of at least one day are systematically underestimated by the market in the 1X2 market.',
      config: {
        dataset: {
          competitionId: null,
          testFrom: twoSeasonsAgo(db),
          testTo: new Date().toISOString(),
          trainSpanDays: 760,
        },
        market: 'ONE_X_TWO' as const,
        matchFilters: [
          { feature: 'eloDiff', op: '>=' as const, value: 90 },
          { feature: 'restDaysDiff', op: '>=' as const, value: 1 },
        ],
        methodology: {
          refitEveryRounds: 4,
          edgeMin: 0.01,
          entryPrice: 'best' as const,
          calibrationMethod: 'isotonic' as const,
        },
      },
      edgeMarket: '1X2 Home',
      edgeTitle: 'Elo favourite with rest advantage',
    },
  ];

  for (const e of experiments) {
    const experimentId = createExperiment(db, {
      title: e.title,
      hypothesis: e.hypothesis,
      config: e.config,
      createdBy: 'system',
    });
    // execute synchronously in this detached chain; statuses reflect outcome
    setImmediate(() => {
      try {
        const result = runExperiment(db, experimentId, 'system');
        const exp = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId) as {
          metrics_json: string | null;
          status: string;
        };
        const metrics = exp?.metrics_json ? JSON.parse(exp.metrics_json) : {};
        seedEdgeFromRun(db, {
          title: e.edgeTitle,
          market_code: e.edgeMarket,
          hypothesis: e.hypothesis,
          experimentId,
          trainingPeriod: 'rolling 760d window (walk-forward)',
          validationPeriod: '150d hold-out per refit',
          oosPeriod: `${e.config.dataset.testFrom.slice(0, 10)} → ${e.config.dataset.testTo.slice(0, 10)}`,
          metrics: {
            roi: metrics?.betting?.roi ?? null,
            brier: metrics?.prediction?.brier ?? null,
            logLoss: metrics?.prediction?.logLoss ?? null,
            maxDrawdownPct: metrics?.betting?.maxDrawdownPct ?? null,
            ece: metrics?.calibration?.ece ?? null,
            clv: metrics?.betting?.clv ?? null,
          },
          sample: metrics?.betting?.selections ?? 0,
          status: result.status === 'PROMISING' ? 'VALIDATING' : result.status === 'REJECTED' ? 'REJECTED' : 'PROMISING',
        });
      } catch (err) {
        console.error('[bootstrap] experiment failed:', err);
      }
    });
  }
  setSetting(db, 'bootstrap_research_v1', 'done');
}

function twoSeasonsAgo(db: ReturnType<typeof getDb>): string {
  const row = db
    .prepare(
      "SELECT start_date FROM seasons WHERE status = 'FINISHED' ORDER BY start_date DESC LIMIT 1 OFFSET 1",
    )
    .get() as { start_date: string } | undefined;
  return row?.start_date ?? new Date(Date.now() - 2 * 365.25 * 86_400_000).toISOString();
}

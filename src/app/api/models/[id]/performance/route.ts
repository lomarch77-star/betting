import { GET_, ok } from '@/lib/api-helpers';
import {
  modelVersionById,
  listBacktestRuns,
  backtestSelections,
} from '@/lib/db/repos-research';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Performance view for a model version: if the version belongs to a backtest
 * run, its OOS metrics are returned; otherwise the version's config +
 * prediction count and linkage to any backtest referencing it.
 */
export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  const v = modelVersionById(ctx.db, id);
  if (!v) return fail(404, 'NOT_FOUND', `No model version ${id}`);
  const runs = listBacktestRuns(ctx.db).filter((r) => r.model_version_id === id);
  const perf = runs.map((r) => {
    const metrics = r.metrics_json ? JSON.parse(r.metrics_json) : null;
    const sels = backtestSelections(ctx.db, r.id);
    return {
      runId: r.id,
      code: r.code,
      status: r.status,
      finishedAt: r.finished_at,
      testMatches: metrics?.testMatches ?? null,
      prediction: metrics?.prediction ?? null,
      calibration: metrics?.calibration
        ? {
            sample: metrics.calibration.sample,
            logLoss: metrics.calibration.logLoss,
            brier: metrics.calibration.brier,
            ece: metrics.calibration.ece,
          }
        : null,
      betting: metrics?.betting ?? null,
      selections: sels.length,
    };
  });
  return ok({
    version: {
      id: v.id,
      code: v.code,
      kind: v.kind,
      name: v.name,
      config: JSON.parse(v.config_json),
      createdAt: v.created_at,
      immutable: true,
    },
    outOfSampleRuns: perf,
  });
});

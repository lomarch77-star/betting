import { GET_, ok } from '@/lib/api-helpers';
import { listEdges, experimentById } from '@/lib/db/repos-research';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  return ok(
    listEdges(ctx.db).map((e) => ({
      id: e.id,
      code: e.code,
      title: e.title,
      market: e.market_code,
      hypothesis: e.hypothesis,
      experiment: e.experiment_id
        ? (() => {
            const x = experimentById(ctx.db, e.experiment_id!);
            return x ? { id: x.id, code: x.code, status: x.status } : null;
          })()
        : null,
      trainingPeriod: e.training_period,
      validationPeriod: e.validation_period,
      oosPeriod: e.oos_period,
      sampleSize: e.sample_size,
      metrics: e.metrics_json ? JSON.parse(e.metrics_json) : null,
      status: e.status,
      createdAt: e.created_at,
    })),
  );
});

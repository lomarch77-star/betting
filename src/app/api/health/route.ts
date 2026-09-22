import { ok } from '@/lib/http';
import { GET_ } from '@/lib/api-helpers';
import { bootstrapStatus } from '@/lib/bootstrap';
import { resolveAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const auth = resolveAuth(req);
  const counts = ctx.db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM matches) AS matches,
        (SELECT COUNT(*) FROM odds_snapshots) AS odds,
        (SELECT COUNT(*) FROM teams) AS teams,
        (SELECT COUNT(*) FROM model_predictions) AS predictions`,
    )
    .get() as Record<string, number>;
  return ok({
    status: 'ok',
    bootstrap: bootstrapStatus(),
    demoAuthMode: auth.demoAuthMode,
    dataset: counts,
    time: new Date().toISOString(),
  });
});

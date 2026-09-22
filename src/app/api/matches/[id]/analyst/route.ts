import { GET_, ok } from '@/lib/api-helpers';
import { analyzeMatch } from '@/lib/services/predictionService';
import { analystSummary } from '@/lib/services/dashboardService';
import { matchById } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Rules-based analyst summary. The analyst layer sits ABOVE the quantitative
 * engine and every numeric claim is traceable (see evidence[] fields) — the
 * layer has no capability to invent statistics (spec §24).
 */
export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  if (!matchById(ctx.db, id)) return fail(404, 'NOT_FOUND', `No match ${id}`);
  const analysis = await analyzeMatch(ctx.db, id);
  if (!analysis) return fail(404, 'NOT_FOUND', `No match ${id}`);
  return ok(analystSummary(analysis));
});

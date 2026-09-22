import { GET_, ok } from '@/lib/api-helpers';
import { analyzeMatch } from '@/lib/services/predictionService';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-1));
  if (!Number.isInteger(id) || id <= 0) return fail(400, 'BAD_ID', 'Invalid match id');
  const analysis = await analyzeMatch(ctx.db, id);
  if (!analysis) return fail(404, 'NOT_FOUND', `No match ${id}`);
  return ok(analysis);
});

import { GET_, ok } from '@/lib/api-helpers';
import { analyzeMatch } from '@/lib/services/predictionService';
import { matchById } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  if (!matchById(ctx.db, id)) return fail(404, 'NOT_FOUND', `No match ${id}`);
  const analysis = await analyzeMatch(ctx.db, id);
  return ok({
    matchId: id,
    prediction: analysis?.prediction ?? null,
    note: analysis?.prediction
      ? 'probabilities ≠ certainties; fair_odds = 1/probability; see uncertainty block'
      : 'no model coverage for this fixture at the required information horizon',
  });
});

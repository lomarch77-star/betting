import { GET_, ok } from '@/lib/api-helpers';
import { analyzeMatch } from '@/lib/services/predictionService';
import { matchById, oddsForMatch, marketDefMap } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  const m = matchById(ctx.db, id);
  if (!m) return fail(404, 'NOT_FOUND', `No match ${id}`);
  const odds = oddsForMatch(ctx.db, id);
  const defs = marketDefMap(ctx.db);
  const bookNames = new Map<number, string>();
  for (const b of ctx.db.prepare('SELECT id, code FROM bookmakers').all() as Array<{
    id: number;
    code: string;
  }>) {
    bookNames.set(b.id, b.code);
  }
  const analysis = await analyzeMatch(ctx.db, id);
  return ok({
    matchId: id,
    snapshots: odds.map((o) => {
      const def = [...defs.values()].find((d) => d.id === o.market_id);
      return {
        bookmaker: bookNames.get(o.bookmaker_id) ?? `book#${o.bookmaker_id}`,
        market: def?.code,
        line: def?.line ?? null,
        selection: o.selection,
        decimalOdds: o.decimal_odds,
        impliedProbability: 1 / o.decimal_odds,
        takenAt: o.taken_at,
        kind: o.kind,
        isDemo: true,
      };
    }),
    marketSummary: analysis?.prices ?? null,
  });
});

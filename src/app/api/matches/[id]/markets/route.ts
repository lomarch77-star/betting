import { GET_, ok } from '@/lib/api-helpers';
import { analyzeMatch } from '@/lib/services/predictionService';
import { matchById } from '@/lib/db/repos-core';
import { fairOdds } from '@/lib/quant/pricing';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Derived market probabilities (from the ensemble-consistent score matrix). */
export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  if (!matchById(ctx.db, id)) return fail(404, 'NOT_FOUND', `No match ${id}`);
  const analysis = await analyzeMatch(ctx.db, id);
  const mk = analysis?.prediction?.derivedMarkets;
  if (!mk) return ok({ matchId: id, markets: null });
  const sel = (market: string, line: number | null, selection: string, p: number) => ({
    market,
    line,
    selection,
    probability: p,
    fairOdds: fairOdds(Math.min(0.999, Math.max(0.001, p))),
  });
  const out = [
    sel('ONE_X_TWO', null, 'HOME', mk.oneXTwo.home),
    sel('ONE_X_TWO', null, 'DRAW', mk.oneXTwo.draw),
    sel('ONE_X_TWO', null, 'AWAY', mk.oneXTwo.away),
    sel('DOUBLE_CHANCE', null, 'HOME_DRAW', mk.doubleChance.homeDraw),
    sel('DOUBLE_CHANCE', null, 'AWAY_DRAW', mk.doubleChance.awayDraw),
    sel('DOUBLE_CHANCE', null, 'HOME_AWAY', mk.doubleChance.homeAway),
    sel('DRAW_NO_BET', null, 'HOME', mk.drawNoBet.home),
    sel('DRAW_NO_BET', null, 'AWAY', mk.drawNoBet.away),
    ...mk.overUnder.flatMap((o) => [
      sel('OU_GOALS', o.line, 'OVER', o.over),
      sel('OU_GOALS', o.line, 'UNDER', o.under),
    ]),
    sel('BTTS', null, 'YES', mk.btts.yes),
    sel('BTTS', null, 'NO', mk.btts.no),
    ...mk.homeTotals.map((t) => sel('TEAM_TOTALS_HOME', t.line, 'OVER', t.over)),
    ...mk.awayTotals.map((t) => sel('TEAM_TOTALS_AWAY', t.line, 'OVER', t.over)),
    ...mk.asianHandicapHome.map((h) =>
      sel('ASIAN_HANDICAP_HOME', h.line, 'COVER', h.cover),
    ),
    ...mk.correctScores.map((s) =>
      sel('CORRECT_SCORE', null, `${s.home}-${s.away}`, s.prob),
    ),
  ];
  return ok({ matchId: id, source: 'ensemble-consistent score matrix', selections: out });
});

import { GET_, ok } from '@/lib/api-helpers';
import { backtestRunById, backtestSelections } from '@/lib/db/repos-research';
import { backtestProgress } from '@/lib/services/backtestService';
import { matchById, teamById } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-1));
  const run = backtestRunById(ctx.db, id);
  if (!run) return fail(404, 'NOT_FOUND', `No backtest run ${id}`);
  const metrics = run.metrics_json ? JSON.parse(run.metrics_json) : null;
  const sels = backtestSelections(ctx.db, id).map((s) => {
    const m = matchById(ctx.db, s.match_id);
    return {
      id: s.id,
      matchId: s.match_id,
      fixture: m
        ? `${teamById(ctx.db, m.home_team_id)?.short_name} vs ${teamById(ctx.db, m.away_team_id)?.short_name}`
        : `#${s.match_id}`,
      kickoff: m?.kickoff_utc,
      marketId: s.market_id,
      selection: s.selection,
      modelProbability: s.model_probability,
      fairOdds: s.fair_odds,
      entryOdds: s.entry_odds,
      closingOdds: s.closing_odds,
      ev: s.ev,
      stake: s.stake,
      won: s.won === 1,
      pnl: s.pnl,
      settledAt: s.settled_at,
      asOf: s.as_of,
    };
  });
  return ok({
    id: run.id,
    code: run.code,
    name: run.name,
    status: run.status,
    config: JSON.parse(run.config_json),
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error,
    progress: backtestProgress(id),
    metrics,
    selections: sels,
  });
});

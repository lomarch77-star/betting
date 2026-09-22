import { z } from 'zod';
import { GET_, ok } from '@/lib/api-helpers';
import { listMatches, teamById } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

const Query = z.object({
  status: z.enum(['SCHEDULED', 'FINISHED', 'POSTPONED', 'CANCELLED']).optional(),
  competitionId: z.coerce.number().int().positive().optional(),
  seasonId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = GET_(async (req, ctx) => {
  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail(400, 'BAD_QUERY', parsed.error.issues[0].message);
  const q = parsed.data;
  const rows = listMatches(ctx.db, {
    status: q.status,
    competitionId: q.competitionId,
    seasonId: q.seasonId,
    from: q.from,
    to: q.to,
    teamId: q.teamId,
    limit: q.limit,
    offset: q.offset,
  });
  const compNames = new Map<number, string>();
  for (const c of ctx.db.prepare('SELECT id, code, name FROM competitions').all() as Array<{
    id: number;
    code: string;
    name: string;
  }>) {
    compNames.set(c.id, `${c.name}`);
  }
  return ok(
    rows.map((m) => ({
      id: m.id,
      kickoff: m.kickoff_utc,
      status: m.status,
      round: m.round,
      competition: compNames.get(m.competition_id),
      competitionId: m.competition_id,
      seasonId: m.season_id,
      homeTeam: teamById(ctx.db, m.home_team_id)?.canonical_name,
      awayTeam: teamById(ctx.db, m.away_team_id)?.canonical_name,
      homeShort: teamById(ctx.db, m.home_team_id)?.short_name,
      awayShort: teamById(ctx.db, m.away_team_id)?.short_name,
      score:
        m.home_goals != null ? { home: m.home_goals, away: m.away_goals } : null,
      qualityStatus: m.quality_status,
      isDemo: m.is_demo === 1,
    })),
    { count: rows.length, limit: q.limit, offset: q.offset },
  );
});

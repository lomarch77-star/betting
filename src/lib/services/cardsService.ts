/**
 * Match-card service — assembles the compact cards shown on the Matches
 * page from PERSISTED predictions (fast SQL; nothing refits here).
 */

import type { Db } from '@/lib/db/client';
import {
  upcomingMatches,
  consensusEntryPrice,
  marketDefMap,
  listMatches,
  teamById,
  type MatchRow,
} from '@/lib/db/repos-core';
import { assessDisagreement } from '@/lib/quant/uncertainty';
import type { Prob3 } from '@/lib/types';

export interface MatchCard {
  id: number;
  kickoff: string;
  round: number;
  competition: string;
  competitionCode: string;
  seasonCode: string;
  homeTeam: string;
  awayTeam: string;
  homeShort: string;
  awayShort: string;
  status: string;
  score: { home: number; away: number } | null;
  quality: string;
  model: Prob3 | null;
  fairOdds: Prob3 | null;
  marketConsensus: Prob3 | null; // as odds
  agreement: 'BROAD' | 'MODERATE' | 'SPLIT' | null;
  bestDiffPct: number | null;
}

function cardFromPersisted(
  db: Db,
  m: MatchRow,
  oneXTwoId: number | undefined,
  comps: Map<number, { code: string; name: string }>,
  seasons: Map<number, string>,
): MatchCard {
  const home = teamById(db, m.home_team_id);
  const away = teamById(db, m.away_team_id);
  const base: MatchCard = {
    id: m.id,
    kickoff: m.kickoff_utc,
    round: m.round,
    competition: comps.get(m.competition_id)?.name ?? '?',
    competitionCode: comps.get(m.competition_id)?.code ?? '?',
    seasonCode: seasons.get(m.season_id) ?? '?',
    homeTeam: home?.canonical_name ?? '?',
    awayTeam: away?.canonical_name ?? '?',
    homeShort: home?.short_name ?? '?',
    awayShort: away?.short_name ?? '?',
    status: m.status,
    score: m.home_goals != null ? { home: m.home_goals, away: m.away_goals! } : null,
    quality: m.quality_status,
    model: null,
    fairOdds: null,
    marketConsensus: null,
    agreement: null,
    bestDiffPct: null,
  };
  if (!oneXTwoId) return base;

  const preds = db
    .prepare(
      `SELECT mp.selection, mp.probability, mp.fair_odds, mp.detail_json
       FROM model_predictions mp
       JOIN model_versions mv ON mv.id = mp.model_version_id AND mv.kind = 'ENSEMBLE'
       WHERE mp.match_id = ? AND mp.market_id = ?
       ORDER BY mp.model_version_id DESC`,
    )
    .all(m.id, oneXTwoId) as Array<{
    selection: string;
    probability: number;
    fair_odds: number;
    detail_json: string | null;
  }>;
  const seen = new Map<string, { p: number; fair: number; detail: string | null }>();
  for (const r of preds) if (!seen.has(r.selection)) seen.set(r.selection, { p: r.probability, fair: r.fair_odds, detail: r.detail_json });
  const h = seen.get('HOME');
  const d = seen.get('DRAW');
  const a = seen.get('AWAY');
  if (h && d && a) {
    base.model = { home: h.p, draw: d.p, away: a.p };
    base.fairOdds = { home: h.fair, draw: d.fair, away: a.fair };
    const now = new Date().toISOString();
    const cons = (sel: string) => consensusEntryPrice(db, m.id, oneXTwoId, sel, now)?.odds ?? null;
    const [ch, cd, ca] = [cons('HOME'), cons('DRAW'), cons('AWAY')];
    if (ch && cd && ca) {
      base.marketConsensus = { home: ch, draw: cd, away: ca };
      const diffs = [ch / h.fair - 1, cd / d.fair - 1, ca / a.fair - 1];
      base.bestDiffPct = Math.max(...diffs);
    }
    if (h.detail) {
      try {
        const detail = JSON.parse(h.detail);
        if (detail?.perModel) {
          base.agreement = assessDisagreement(
            Object.entries(detail.perModel).map(([kind, probs]) => ({
              kind,
              probs: probs as Prob3,
            })),
          ).label;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return base;
}

export function upcomingCards(db: Db, opts: { competitionId?: number; days?: number } = {}): MatchCard[] {
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + (opts.days ?? 45) * 86_400_000).toISOString();
  const matches = upcomingMatches(db, now, horizon, { competitionId: opts.competitionId }).filter(
    (m) => m.quality_status !== 'INVALID',
  );
  const defs = marketDefMap(db);
  const oneXTwoId = defs.get('ONE_X_TWO|null')?.id;
  const comps = new Map(
    (db.prepare('SELECT id, code, name FROM competitions').all() as Array<{ id: number; code: string; name: string }>).map(
      (c) => [c.id, { code: c.code, name: c.name }],
    ),
  );
  const seasons = new Map(
    (db.prepare('SELECT id, code FROM seasons').all() as Array<{ id: number; code: string }>).map((s) => [s.id, s.code]),
  );
  return matches.map((m) => cardFromPersisted(db, m, oneXTwoId, comps, seasons));
}

export function finishedCards(
  db: Db,
  opts: { competitionId?: number; limit?: number; offset?: number } = {},
): MatchCard[] {
  const matches = listMatches(db, {
    status: 'FINISHED',
    competitionId: opts.competitionId,
    limit: opts.limit ?? 60,
    offset: opts.offset ?? 0,
  }).reverse();
  const comps = new Map(
    (db.prepare('SELECT id, code, name FROM competitions').all() as Array<{ id: number; code: string; name: string }>).map(
      (c) => [c.id, { code: c.code, name: c.name }],
    ),
  );
  const seasons = new Map(
    (db.prepare('SELECT id, code FROM seasons').all() as Array<{ id: number; code: string }>).map((s) => [s.id, s.code]),
  );
  const defs = marketDefMap(db);
  const oneXTwoId = defs.get('ONE_X_TWO|null')?.id;
  return matches.map((m) => cardFromPersisted(db, m, oneXTwoId, comps, seasons));
}

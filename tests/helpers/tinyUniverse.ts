/**
 * Hermetic fixture: a tiny deterministic football universe in an in-memory DB.
 * 8 teams, 1 league, 60 weekly rounds of results + odds priced off the same
 * skill model that generated results (so a good model can genuinely learn).
 */

import type { Db } from '@/lib/db/client';
import { createTestDb, tx } from '@/lib/db/client';
import {
  insertCompetition,
  insertSeason,
  insertTeam,
  insertBookmaker,
  ensureMarketDef,
  insertMatch,
  insertOdds,
} from '@/lib/db/repos-core';
import { Rng } from '@/lib/quant/random';
import { independentPoissonMatrix, deriveMarkets } from '@/lib/quant/poisson';

const DAY = 86_400_000;

export interface TinyUniverse {
  db: Db;
  teamIds: number[];
  competitionId: number;
  seasonId: number;
  startIso: string;
  endIso: string;
}

export function buildTinyUniverse(seed = 1234, rounds = 56): TinyUniverse {
  const db = createTestDb();
  const rng = new Rng(seed);
  const startMs = Date.UTC(2025, 0, 4, 15, 0, 0);

  let competitionId = 0;
  let seasonId = 0;
  const teamIds: number[] = [];
  const skills: Array<{ att: number; def: number }> = [];

  tx(db, () => {
    competitionId = insertCompetition(db, { code: 'TINY', name: 'Tiny Test League', tier: 1, region: 'TEST' });
    seasonId = insertSeason(db, {
      competition_id: competitionId,
      code: '2024-25',
      start_date: new Date(startMs - DAY).toISOString(),
      end_date: new Date(startMs + (rounds + 2) * 7 * DAY).toISOString(),
      status: 'ACTIVE',
    });
    for (let i = 0; i < 8; i++) {
      teamIds.push(
        insertTeam(db, {
          canonical_name: `Test Club ${String.fromCharCode(65 + i)}`,
          short_name: `T${String.fromCharCode(65 + i)}`,
          aliases: '[]',
        }),
      );
      skills.push({ att: rng.gaussian(0, 0.17), def: rng.gaussian(0, 0.17) });
    }
    insertBookmaker(db, { code: 'TB1', name: 'Test Book One', margin_profile: 0.04, is_demo: 1 });
    insertBookmaker(db, { code: 'TB2', name: 'Test Book Two', margin_profile: 0.06, is_demo: 1 });
    const m1x2 = ensureMarketDef(db, 'ONE_X_TWO', null, '1X2');
    const mOu = ensureMarketDef(db, 'OU_GOALS', 2.5, 'OU 2.5');

    // round robin repeated
    const fixtures: Array<[number, number]> = [];
    for (let r = 0; r < rounds; r++) {
      const rotated = [...teamIds];
      for (let i = 0; i < 4; i++) {
        fixtures.push(r % 2 === 0 ? [rotated[i], rotated[7 - i]] : [rotated[7 - i], rotated[i]]);
      }
      teamIds.splice(1, 0, teamIds.pop()!);
    }

    fixtures.forEach(([hId, aId], idx) => {
      const kickoff = new Date(startMs + Math.floor(idx / 4) * 7 * DAY + (idx % 4) * 3_600_000);
      const hs = skills[teamIds.indexOf(hId)];
      const as = skills[teamIds.indexOf(aId)];
      const lamH = Math.exp(Math.log(1.4) + 0.26 + hs.att - as.def);
      const lamA = Math.exp(Math.log(1.4) + as.att - hs.def);
      const hg = rng.poisson(lamH);
      const ag = rng.poisson(lamA);
      const matchId = insertMatch(db, {
        competition_id: competitionId,
        season_id: seasonId,
        round: Math.floor(idx / 4) + 1,
        kickoff_utc: kickoff.toISOString(),
        home_team_id: hId,
        away_team_id: aId,
        status: 'FINISHED',
        home_goals: hg,
        away_goals: ag,
        home_xg: Math.max(0.1, lamH + rng.gaussian(0, 0.3)),
        away_xg: Math.max(0.1, lamA + rng.gaussian(0, 0.3)),
        home_shots: Math.round(8 + 3 * lamH),
        away_shots: Math.round(8 + 3 * lamA),
      });
      const mk = deriveMarkets(independentPoissonMatrix(lamH, lamA), { ouLines: [2.5] });
      const rows: Parameters<typeof insertOdds>[1] = [];
      for (const book of [1, 2]) {
        const margin = book === 1 ? 1.04 : 1.06;
        const probs1x2 = [mk.oneXTwo.home, mk.oneXTwo.draw, mk.oneXTwo.away];
        const sels = ['HOME', 'DRAW', 'AWAY'];
        probs1x2.forEach((p, i) => {
          const noisy = p * (1 + rng.gaussian(0, 0.04));
          rows.push({
            match_id: matchId,
            bookmaker_id: book,
            market_id: m1x2,
            selection: sels[i],
            decimal_odds: Math.max(1.05, Math.round((1 / (noisy * margin)) * 100) / 100),
            taken_at: new Date(kickoff.getTime() - 26 * 3_600_000).toISOString(),
            kind: 'MID',
          });
        });
        const pOver = mk.overUnder[0].over * (1 + rng.gaussian(0, 0.03));
        rows.push(
          {
            match_id: matchId,
            bookmaker_id: book,
            market_id: mOu,
            selection: 'OVER',
            decimal_odds: Math.max(1.05, Math.round((1 / (pOver * margin)) * 100) / 100),
            taken_at: new Date(kickoff.getTime() - 26 * 3_600_000).toISOString(),
            kind: 'MID',
          },
          {
            match_id: matchId,
            bookmaker_id: book,
            market_id: mOu,
            selection: 'UNDER',
            decimal_odds: Math.max(1.05, Math.round((1 / ((1 - pOver) * margin)) * 100) / 100),
            taken_at: new Date(kickoff.getTime() - 26 * 3_600_000).toISOString(),
            kind: 'MID',
          },
        );
      }
      insertOdds(db, rows);
    });
  });

  return {
    db,
    teamIds,
    competitionId,
    seasonId,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + rounds * 7 * DAY).toISOString(),
  };
}

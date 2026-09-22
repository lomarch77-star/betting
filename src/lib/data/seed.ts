/**
 * Seed orchestration: builds the deterministic demo universe into the
 * database, inserts market definitions, bookmakers, deliberate anomalies
 * (for the data-quality subsystem to detect), and computes season rollups.
 *
 * Idempotent: checks for an existing demo seed fingerprint and skips work
 * when already present (unless forced).
 */

import type { Db } from '@/lib/db/client';
import { tx, nowIso } from '@/lib/db/client';
import {
  insertCompetition,
  insertSeason,
  insertTeam,
  insertVenue,
  insertBookmaker,
  ensureMarketDef,
  insertMatch,
  insertOdds,
  teamByName,
  type MatchRow,
} from '@/lib/db/repos-core';
import { getSetting, setSetting } from '@/lib/db/repos-research';
import { generateUniverse, LEAGUES, BOOKMAKERS, type GeneratedUniverse } from './demoLeague';

export interface SeedResult {
  matches: number;
  odds: number;
  seasons: number;
  teams: number;
  skipped: boolean;
  anchorIso: string;
}

export const SEED_FINGERPRINT_KEY = 'demo_seed_fingerprint';

export function anchorDateIso(): string {
  const env = process.env.DEMO_ANCHOR_DATE;
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) return new Date(`${env}T00:00:00Z`).toISOString();
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Seed the demo universe. Requires the DB to be empty of demo data
 * (or `force` to have been handled by the caller wiping demo rows).
 */
export function seedDemoUniverse(db: Db, opts: { force?: boolean } = {}): SeedResult {
  const seed = Number(process.env.DEMO_SEED ?? 42);
  const anchorIso = anchorDateIso();
  const fingerprint = `seed=${seed}|anchor=${anchorIso.slice(0, 10)}`;
  const existing = getSetting(db, SEED_FINGERPRINT_KEY);
  if (existing === fingerprint && !opts.force) {
    return { matches: 0, odds: 0, seasons: 0, teams: 0, skipped: true, anchorIso };
  }
  if (existing && existing !== fingerprint && !opts.force) {
    // Anchor moved (new day) — keep historical universe; nothing to do.
    return { matches: 0, odds: 0, seasons: 0, teams: 0, skipped: true, anchorIso };
  }

  const universe = generateUniverseFromEnv(seed, anchorIso);
  const result = persistUniverse(db, universe);
  setSetting(db, SEED_FINGERPRINT_KEY, fingerprint);
  setSetting(db, 'demo_anchor', anchorIso);
  return { ...result, skipped: false, anchorIso };
}

export function generateUniverseFromEnv(seed: number, anchorIso: string) {
  return generateUniverse(seed, anchorIso);
}

function persistUniverse(
  db: Db,
  universe: GeneratedUniverse,
): Omit<SeedResult, 'skipped' | 'anchorIso'> {
  let matchCount = 0;
  let oddsCount = 0;
  let seasonCount = 0;
  let teamCount = 0;

  tx(db, () => {
    // ── catalog ──
    const leagueIds = new Map<string, number>();
    const seasonIds = new Map<string, number>(); // key leagueCode|seasonCode
    const teamIds = new Map<string, number>(); // canonical name → id
    type TeamMeta = { venueId: number };
    const teamMeta = new Map<string, TeamMeta>();

    for (const league of LEAGUES) {
      const compId = insertCompetition(db, {
        code: league.code,
        name: league.name,
        tier: league.tier,
        region: 'DEMO',
      });
      leagueIds.set(league.code, compId);
      for (const t of universe.teams[league.code]) {
        const id = insertTeam(db, {
          canonical_name: t.name,
          short_name: t.short,
          aliases: JSON.stringify([t.name, t.short]),
        });
        teamIds.set(t.name, id);
        teamCount++;
        const venueId = insertVenue(db, t.venue, t.city, id);
        teamMeta.set(t.name, { venueId });
      }
    }

    for (const s of universe.seasons) {
      const id = insertSeason(db, {
        competition_id: leagueIds.get(s.leagueCode)!,
        code: s.code,
        start_date: s.start,
        end_date: s.end,
        status: s.status,
      });
      seasonIds.set(`${s.leagueCode}|${s.code}`, id);
      seasonCount++;
    }

    for (const b of BOOKMAKERS) {
      insertBookmaker(db, { code: b.code, name: b.name, margin_profile: b.margin, is_demo: 1 });
    }

    // ── market definitions ──
    const marketIds = new Map<string, number>();
    const def = (code: string, line: number | null, name: string) => {
      marketIds.set(`${code}|${line}`, ensureMarketDef(db, code, line, name));
    };
    def('ONE_X_TWO', null, 'Full-Time Result (1X2)');
    def('OU_GOALS', 2.5, 'Total Goals Over/Under 2.5');
    def('OU_GOALS', 1.5, 'Total Goals Over/Under 1.5');
    def('OU_GOALS', 3.5, 'Total Goals Over/Under 3.5');
    def('BTTS', null, 'Both Teams To Score');
    // model-only derived markets (no demo bookmaker prices)
    def('DOUBLE_CHANCE', null, 'Double Chance');
    def('DRAW_NO_BET', null, 'Draw No Bet');
    def('OU_GOALS', 0.5, 'Total Goals Over/Under 0.5');
    def('TEAM_TOTALS', 1.5, 'Team Goals Over/Under 1.5');
    def('ASIAN_HANDICAP', -1.0, 'Asian Handicap Home -1.0');
    def('ASIAN_HANDICAP', 1.0, 'Asian Handicap Home +1.0');
    def('CORRECT_SCORE', null, 'Correct Score (top outcomes)');

    const bookIds = new Map<string, number>();
    for (const b of db.prepare('SELECT id, code FROM bookmakers').all() as unknown as Array<{
      id: number;
      code: string;
    }>) {
      bookIds.set(b.code, b.id);
    }

    // ── matches ──
    const matchKeyToId = new Map<string, number>();
    for (const m of universe.matches) {
      const id = insertMatch(db, {
        competition_id: leagueIds.get(m.leagueCode)!,
        season_id: seasonIds.get(`${m.leagueCode}|${m.seasonCode}`)!,
        round: m.round,
        kickoff_utc: m.kickoff,
        home_team_id: teamIds.get(m.homeTeam)!,
        away_team_id: teamIds.get(m.awayTeam)!,
        venue_id: teamMeta.get(m.homeTeam)!.venueId,
        status: m.status,
        home_goals: m.homeGoals,
        away_goals: m.awayGoals,
        home_xg: m.homeXg,
        away_xg: m.awayXg,
        home_shots: m.homeShots,
        away_shots: m.awayShots,
        home_shots_on: m.homeShotsOn,
        away_shots_on: m.awayShotsOn,
        home_corners: m.homeCorners,
        away_corners: m.awayCorners,
        possession_home: m.possessionHome,
      });
      matchKeyToId.set(matchKey(m), id);
      matchCount++;
    }

    // ── odds (bulk) ──
    const CHUNK = 8000;
    let buffer: Parameters<typeof insertOdds>[1] = [];
    for (const o of universe.odds) {
      const matchId = matchKeyToId.get(
        `${o.leagueCode}|${o.seasonCode}|${o.round}|${o.homeTeam}|${o.awayTeam}`,
      );
      if (!matchId) continue;
      const marketId = marketIds.get(`${o.marketCode}|${o.line}`);
      if (!marketId) continue;
      buffer.push({
        match_id: matchId,
        bookmaker_id: bookIds.get(o.bookmakerCode)!,
        market_id: marketId,
        selection: o.selection,
        decimal_odds: o.odds,
        taken_at: o.takenAt,
        kind: o.kind,
      });
      if (buffer.length >= CHUNK) {
        insertOdds(db, buffer);
        oddsCount += buffer.length;
        buffer = [];
      }
    }
    if (buffer.length) {
      insertOdds(db, buffer);
      oddsCount += buffer.length;
    }

    // ── team_seasons rollups for finished seasons ── désigne final positions
    rollupTeamSeasons(db, universe);

    // ── deliberate anomalies for the data-quality subsystem to detect ──
    seedAnomalies(db, universe, matchKeyToId);
  });

  return { matches: matchCount, odds: oddsCount, seasons: seasonCount, teams: teamCount };
}

function matchKey(m: {
  leagueCode: string;
  seasonCode: string;
  round: number;
  homeTeam: string;
  awayTeam: string;
}): string {
  return `${m.leagueCode}|${m.seasonCode}|${m.round}|${m.homeTeam}|${m.awayTeam}`;
}

/** Aggregate team_seasons + final positions from completed seasons. */
function rollupTeamSeasons(db: Db, universe: GeneratedUniverse): void {
  const seasons = universe.seasons.filter((s) => s.status === 'FINISHED');
  for (const s of seasons) {
    interface Row {
      teamId: number;
      p: number;
      w: number;
      d: number;
      l: number;
      gf: number;
      ga: number;
      pts: number;
    }
    const table = new Map<number, Row>();
    const rows = db
      .prepare(
        `SELECT m.* FROM matches m
         JOIN seasons sn ON sn.id = m.season_id
         JOIN competitions c ON c.id = m.competition_id
         WHERE sn.code = ? AND c.code = ? AND m.status = 'FINISHED'`,
      )
      .all(s.code, s.leagueCode) as unknown as MatchRow[];
    for (const m of rows) {
      for (const side of ['home', 'away'] as const) {
        const teamId = side === 'home' ? m.home_team_id : m.away_team_id;
        const t =
          table.get(teamId) ??
          ({ teamId, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 } satisfies Row);
        const gf = side === 'home' ? m.home_goals! : m.away_goals!;
        const ga = side === 'home' ? m.away_goals! : m.home_goals!;
        t.p++;
        t.gf += gf;
        t.ga += ga;
        if (gf > ga) {
          t.w++;
          t.pts += 3;
        } else if (gf === ga) {
          t.d++;
          t.pts += 1;
        } else t.l++;
        table.set(teamId, t);
      }
    }
    const ordered = [...table.values()].sort(
      (a, b) => b.pts - a.pts || b.gf - b.ga - (a.gf - a.ga) || b.gf - a.gf,
    );
    const sid = (
      db
        .prepare(
          `SELECT sn.id FROM seasons sn JOIN competitions c ON c.id = sn.competition_id
           WHERE sn.code = ? AND c.code = ?`,
        )
        .get(s.code, s.leagueCode) as { id: number } | undefined
    )?.id;
    if (!sid) continue;
    const stmt = db.prepare(
      `INSERT INTO team_seasons (team_id, season_id, final_position, points, played, won, drawn, lost, goals_for, goals_against)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ordered.forEach((t, i) => {
      stmt.run(t.teamId, sid, i + 1, t.pts, t.p, t.w, t.d, t.l, t.gf, t.ga);
    });
  }
}

/**
 * Three deliberate anomalies (documented, is_demo): the DQ subsystem must
 * detect and quarantine them. They prove the rules engine works end-to-end.
 */
function seedAnomalies(
  db: Db,
  universe: GeneratedUniverse,
  matchKeyToId: Map<string, number>,
): void {
  const corrupt = universe.matches.find(
    (m) => m.status === 'FINISHED' && m.seasonCode === universe.seasons[universe.seasons.length - 2]?.code,
  );
  if (corrupt) {
    const id = matchKeyToId.get(matchKey(corrupt));
    if (id) {
      // corrupted statistic: impossible xG value
      db.prepare('UPDATE matches SET home_xg = 47.5 WHERE id = ?').run(id);
    }
  }
  // future-result leak: a FINISHED match after the anchor (must never reach training)
  const anchor = Date.parse(universe.anchorIso);
  const anyFinished = universe.matches.find((m) => m.status === 'FINISHED');
  if (anyFinished) {
    const base = { ...anyFinished };
    base.round = 99;
    base.kickoff = new Date(anchor + 9 * 86_400_000).toISOString();
    base.status = 'FINISHED';
    base.homeGoals = 7;
    base.awayGoals = 0;
    base.homeXg = 3.1;
    base.awayXg = 0.2;
    // swap home/away to avoid the UNIQUE constraint clash
    const swappedHome = base.awayTeam;
    base.awayTeam = base.homeTeam;
    base.homeTeam = swappedHome;
    const home = teamByName(db, base.homeTeam);
    const away = teamByName(db, base.awayTeam);
    const seasonRow = db
      .prepare(
        `SELECT sn.id, sn.competition_id FROM seasons sn JOIN competitions c ON c.id = sn.competition_id
         WHERE sn.code = ? AND c.code = ?`,
      )
      .get(base.seasonCode, base.leagueCode) as { id: number; competition_id: number } | undefined;
    if (home && away && seasonRow) {
      insertMatch(db, {
        competition_id: seasonRow.competition_id,
        season_id: seasonRow.id,
        round: base.round,
        kickoff_utc: base.kickoff,
        home_team_id: home.id,
        away_team_id: away.id,
        status: 'FINISHED',
        home_goals: base.homeGoals,
        away_goals: base.awayGoals,
        home_xg: base.homeXg,
        away_xg: base.awayXg,
        ingestion_id: 'seed-anomaly',
      });
    }
  }
  // out-of-range odds handled below via direct insert (bypasses CHECK-less range issues)
  const anyFinishedId = anyFinished && matchKeyToId.get(matchKey(anyFinished));
  if (anyFinishedId) {
    const mkts = db
      .prepare("SELECT id FROM market_defs WHERE code = 'ONE_X_TWO'")
      .get() as { id: number } | undefined;
    const bk = db.prepare("SELECT id FROM bookmakers WHERE code = 'CROWN'").get() as
      | { id: number }
      | undefined;
    if (mkts && bk) {
      db.prepare(
        `INSERT OR IGNORE INTO odds_snapshots
         (match_id, bookmaker_id, market_id, selection, decimal_odds, taken_at, kind, is_demo)
         VALUES (?, ?, ?, 'DRAW', 13.5, ?, 'OPEN', 1)`,
      ).run(anyFinishedId, bk.id, mkts.id, nowIso());
    }
  }
}

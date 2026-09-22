/**
 * Core repositories: catalog entities (competitions, seasons, teams, venues,
 * bookmakers, market definitions), matches and odds snapshots.
 *
 * LEAKAGE CONTRACT: any function whose name includes `Before` or takes an
 * `asOf` timestamp returns only information available strictly within that
 * information horizon. Training features may only be built from these.
 */

import type { Db } from './client';
import { nowIso } from './client';
import type { MatchStatus, QualityStatus, OddsKind } from '@/lib/types';

// ─── Row types ───────────────────────────────────────────────────────────────

export interface CompetitionRow {
  id: number;
  code: string;
  name: string;
  tier: number;
  region: string;
}

export interface SeasonRow {
  id: number;
  competition_id: number;
  code: string;
  start_date: string;
  end_date: string;
  status: string;
}

export interface TeamRow {
  id: number;
  canonical_name: string;
  short_name: string;
  aliases: string;
}

export interface BookmakerRow {
  id: number;
  code: string;
  name: string;
  margin_profile: number;
  is_demo: number;
}

export interface MarketDefRow {
  id: number;
  code: string;
  line: number | null;
  name: string;
}

export interface MatchRow {
  id: number;
  competition_id: number;
  season_id: number;
  round: number;
  kickoff_utc: string;
  home_team_id: number;
  away_team_id: number;
  venue_id: number | null;
  status: MatchStatus;
  home_goals: number | null;
  away_goals: number | null;
  home_xg: number | null;
  away_xg: number | null;
  home_shots: number | null;
  away_shots: number | null;
  home_shots_on: number | null;
  away_shots_on: number | null;
  home_corners: number | null;
  away_corners: number | null;
  possession_home: number | null;
  data_source: string;
  is_demo: number;
  quality_status: QualityStatus;
  ingestion_id: string;
}

export interface OddsRow {
  id: number;
  match_id: number;
  bookmaker_id: number;
  market_id: number;
  selection: string;
  decimal_odds: number;
  taken_at: string;
  kind: OddsKind;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export function insertCompetition(db: Db, c: Omit<CompetitionRow, 'id'>): number {
  return Number(
    db
      .prepare(
        'INSERT INTO competitions (code, name, tier, region) VALUES (?, ?, ?, ?)',
      )
      .run(c.code, c.name, c.tier, c.region).lastInsertRowid,
  );
}

export function competitionByCode(db: Db, code: string): CompetitionRow | undefined {
  return db.prepare('SELECT * FROM competitions WHERE code = ?').get(code) as
    | CompetitionRow
    | undefined;
}

export function listCompetitions(db: Db): CompetitionRow[] {
  return db.prepare('SELECT * FROM competitions ORDER BY tier, name').all() as unknown as CompetitionRow[];
}

export function insertSeason(db: Db, s: Omit<SeasonRow, 'id'>): number {
  return Number(
    db
      .prepare(
        'INSERT INTO seasons (competition_id, code, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.competition_id, s.code, s.start_date, s.end_date, s.status).lastInsertRowid,
  );
}

export function listSeasons(db: Db): SeasonRow[] {
  return db.prepare('SELECT * FROM seasons ORDER BY competition_id, code').all() as unknown as SeasonRow[];
}

export function seasonById(db: Db, id: number): SeasonRow | undefined {
  return db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) as SeasonRow | undefined;
}

export function insertTeam(db: Db, t: Omit<TeamRow, 'id'>): number {
  return Number(
    db
      .prepare('INSERT INTO teams (canonical_name, short_name, aliases) VALUES (?, ?, ?)')
      .run(t.canonical_name, t.short_name, t.aliases).lastInsertRowid,
  );
}

export function listTeams(db: Db): TeamRow[] {
  return db.prepare('SELECT * FROM teams ORDER BY canonical_name').all() as unknown as TeamRow[];
}

export function teamById(db: Db, id: number): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
}

export function teamByName(db: Db, name: string): TeamRow | undefined {
  return db
    .prepare('SELECT * FROM teams WHERE canonical_name = ? OR short_name = ?')
    .get(name, name) as TeamRow | undefined;
}

export function insertVenue(db: Db, name: string, city: string, teamId: number | null): number {
  return Number(
    db
      .prepare('INSERT INTO venues (name, city, team_id) VALUES (?, ?, ?)')
      .run(name, city, teamId).lastInsertRowid,
  );
}

export function insertBookmaker(db: Db, b: Omit<BookmakerRow, 'id'>): number {
  return Number(
    db
      .prepare(
        'INSERT INTO bookmakers (code, name, margin_profile, is_demo) VALUES (?, ?, ?, ?)',
      )
      .run(b.code, b.name, b.margin_profile, b.is_demo).lastInsertRowid,
  );
}

export function listBookmakers(db: Db): BookmakerRow[] {
  return db.prepare('SELECT * FROM bookmakers ORDER BY code').all() as unknown as BookmakerRow[];
}

export function ensureMarketDef(
  db: Db,
  code: string,
  line: number | null,
  name: string,
): number {
  const existing = db
    .prepare('SELECT id FROM market_defs WHERE code = ? AND line IS ?')
    .get(code, line) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(
    db.prepare('INSERT INTO market_defs (code, line, name) VALUES (?, ?, ?)').run(code, line, name)
      .lastInsertRowid,
  );
}

export function listMarketDefs(db: Db): MarketDefRow[] {
  return db.prepare('SELECT * FROM market_defs ORDER BY code, line').all() as unknown as MarketDefRow[];
}

/** id lookup keyed by code|line for fast mapping. */
export function marketDefMap(db: Db): Map<string, MarketDefRow> {
  const m = new Map<string, MarketDefRow>();
  for (const r of listMarketDefs(db)) m.set(`${r.code}|${r.line ?? 'null'}`, r);
  return m;
}

// ─── Matches ─────────────────────────────────────────────────────────────────

export interface NewMatch {
  competition_id: number;
  season_id: number;
  round: number;
  kickoff_utc: string;
  home_team_id: number;
  away_team_id: number;
  venue_id?: number | null;
  status: MatchStatus;
  home_goals?: number | null;
  away_goals?: number | null;
  home_xg?: number | null;
  away_xg?: number | null;
  home_shots?: number | null;
  away_shots?: number | null;
  home_shots_on?: number | null;
  away_shots_on?: number | null;
  home_corners?: number | null;
  away_corners?: number | null;
  possession_home?: number | null;
  data_source?: string;
  is_demo?: number;
  quality_status?: QualityStatus;
  ingestion_id?: string;
}

const MATCH_COLS = `competition_id, season_id, round, kickoff_utc, home_team_id, away_team_id,
  venue_id, status, home_goals, away_goals, home_xg, away_xg, home_shots, away_shots,
  home_shots_on, away_shots_on, home_corners, away_corners, possession_home,
  data_source, is_demo, quality_status, ingestion_id, created_at, updated_at`;

export function insertMatch(db: Db, m: NewMatch): number {
  const now = nowIso();
  return Number(
    db
      .prepare(
        `INSERT INTO matches (${MATCH_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.competition_id,
        m.season_id,
        m.round,
        m.kickoff_utc,
        m.home_team_id,
        m.away_team_id,
        m.venue_id ?? null,
        m.status,
        m.home_goals ?? null,
        m.away_goals ?? null,
        m.home_xg ?? null,
        m.away_xg ?? null,
        m.home_shots ?? null,
        m.away_shots ?? null,
        m.home_shots_on ?? null,
        m.away_shots_on ?? null,
        m.home_corners ?? null,
        m.away_corners ?? null,
        m.possession_home ?? null,
        m.data_source ?? 'demo-generator-v1',
        m.is_demo ?? 1,
        m.quality_status ?? 'VALID',
        m.ingestion_id ?? 'seed',
        now,
        now,
      ).lastInsertRowid,
  );
}

export function matchById(db: Db, id: number): MatchRow | undefined {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
}

export interface MatchFilter {
  competitionId?: number;
  seasonId?: number;
  status?: MatchStatus;
  from?: string; // kickoff >= from
  to?: string; // kickoff < to
  teamId?: number;
  quality?: QualityStatus;
  limit?: number;
  offset?: number;
}

export function listMatches(db: Db, f: MatchFilter = {}): MatchRow[] {
  const where: string[] = [];
  const args: (number | string)[] = [];
  if (f.competitionId) {
    where.push('competition_id = ?');
    args.push(f.competitionId);
  }
  if (f.seasonId) {
    where.push('season_id = ?');
    args.push(f.seasonId);
  }
  if (f.status) {
    where.push('status = ?');
    args.push(f.status);
  }
  if (f.from) {
    where.push('kickoff_utc >= ?');
    args.push(f.from);
  }
  if (f.to) {
    where.push('kickoff_utc < ?');
    args.push(f.to);
  }
  if (f.teamId) {
    where.push('(home_team_id = ? OR away_team_id = ?)');
    args.push(f.teamId, f.teamId);
  }
  if (f.quality) {
    where.push('quality_status = ?');
    args.push(f.quality);
  }
  const sql = `SELECT * FROM matches ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY kickoff_utc ASC LIMIT ? OFFSET ?`;
  args.push(f.limit ?? 500, f.offset ?? 0);
  return db.prepare(sql).all(...args) as unknown as MatchRow[];
}

/**
 * THE training-data query: finished, VALID-quality matches kicked off
 * strictly before `asOf`, ascending. Feature pipelines must source from
 * this (or an equivalent strictly-bounded query) only.
 */
export function finishedBefore(
  db: Db,
  asOf: string,
  opts: { competitionId?: number; from?: string; excludeInvalid?: boolean } = {},
): MatchRow[] {
  const where = ["status = 'FINISHED'", 'kickoff_utc < ?'];
  const args: (number | string)[] = [asOf];
  if (opts.excludeInvalid !== false) {
    where.push("quality_status != 'INVALID'");
  }
  if (opts.competitionId) {
    where.push('competition_id = ?');
    args.push(opts.competitionId);
  }
  if (opts.from) {
    where.push('kickoff_utc >= ?');
    args.push(opts.from);
  }
  return db
    .prepare(`SELECT * FROM matches WHERE ${where.join(' AND ')} ORDER BY kickoff_utc ASC`)
    .all(...args) as unknown as MatchRow[];
}

export function upcomingMatches(
  db: Db,
  from: string,
  to: string,
  opts: { competitionId?: number } = {},
): MatchRow[] {
  const where = ["status = 'SCHEDULED'", 'kickoff_utc >= ?', 'kickoff_utc < ?'];
  const args: (number | string)[] = [from, to];
  if (opts.competitionId) {
    where.push('competition_id = ?');
    args.push(opts.competitionId);
  }
  return db
    .prepare(`SELECT * FROM matches WHERE ${where.join(' AND ')} ORDER BY kickoff_utc ASC`)
    .all(...args) as unknown as MatchRow[];
}

export function countMatchesByStatus(db: Db): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM matches GROUP BY status')
    .all() as unknown as Array<{ status: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.c]));
}

export function latestKickoff(db: Db): string | null {
  const r = db
    .prepare("SELECT MAX(kickoff_utc) AS k FROM matches WHERE status = 'FINISHED'")
    .get() as { k: string | null };
  return r.k;
}

export function setMatchQuality(db: Db, id: number, q: QualityStatus): void {
  db.prepare('UPDATE matches SET quality_status = ?, updated_at = ? WHERE id = ?').run(
    q,
    nowIso(),
    id,
  );
}

// ─── Odds ────────────────────────────────────────────────────────────────────

export function insertOdds(db: Db, rows: Array<Omit<OddsRow, 'id'>>): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO odds_snapshots
     (match_id, bookmaker_id, market_id, selection, decimal_odds, taken_at, kind, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const r of rows) {
    stmt.run(r.match_id, r.bookmaker_id, r.market_id, r.selection, r.decimal_odds, r.taken_at, r.kind);
  }
}

export function oddsForMatch(db: Db, matchId: number): OddsRow[] {
  return db
    .prepare(
      'SELECT * FROM odds_snapshots WHERE match_id = ? ORDER BY market_id, selection, taken_at',
    )
    .all(matchId) as unknown as OddsRow[];
}

/**
 * Best available entry price for a selection at information horizon `asOf`:
 * the latest snapshot from each book taken at or before asOf, max across books.
 * Closing prices taken after asOf are correctly excluded (chronology guard).
 */
export function bestEntryPrice(
  db: Db,
  matchId: number,
  marketId: number,
  selection: string,
  asOf: string,
): { odds: number; bookmakerId: number; takenAt: string } | null {
  const row = db
    .prepare(
      `SELECT o.decimal_odds AS odds, o.bookmaker_id AS bookmakerId, MAX(o.taken_at) AS takenAt
       FROM odds_snapshots o
       WHERE o.match_id = ? AND o.market_id = ? AND o.selection = ? AND o.taken_at <= ?
       GROUP BY o.bookmaker_id
       ORDER BY o.decimal_odds DESC
       LIMIT 1`,
    )
    .get(matchId, marketId, selection, asOf) as
    | { odds: number; bookmakerId: number; takenAt: string }
    | undefined;
  return row ?? null;
}

/**
 * Consensus entry price: implied-probability-average across books of their
 * latest pre-asOf prices, then converted back to odds. Robust to one stale
 * book and a defensible default for research.
 */
export function consensusEntryPrice(
  db: Db,
  matchId: number,
  marketId: number,
  selection: string,
  asOf: string,
): { odds: number; bookCount: number } | null {
  const rows = db
    .prepare(
      `SELECT o.bookmaker_id, o.decimal_odds AS odds
       FROM odds_snapshots o
       JOIN (
         SELECT bookmaker_id, MAX(taken_at) AS mt FROM odds_snapshots
         WHERE match_id = ? AND market_id = ? AND selection = ? AND taken_at <= ?
         GROUP BY bookmaker_id
       ) latest ON latest.bookmaker_id = o.bookmaker_id AND latest.mt = o.taken_at
       WHERE o.match_id = ? AND o.market_id = ? AND o.selection = ?`,
    )
    .all(matchId, marketId, selection, asOf, matchId, marketId, selection) as unknown as Array<{
    bookmaker_id: number;
    odds: number;
  }>;
  if (rows.length === 0) return null;
  const implied = rows.reduce((a, r) => a + 1 / r.odds, 0) / rows.length;
  return { odds: 1 / implied, bookCount: rows.length };
}

/** Closing price (final snapshot regardless of asOf) — settlement/diagnostics only. */
export function closingPrice(
  db: Db,
  matchId: number,
  marketId: number,
  selection: string,
): number | null {
  const row = db
    .prepare(
      `SELECT decimal_odds AS o FROM odds_snapshots
       WHERE match_id = ? AND market_id = ? AND selection = ?
       ORDER BY taken_at DESC LIMIT 1`,
    )
    .get(matchId, marketId, selection) as { o: number } | undefined;
  return row?.o ?? null;
}

/** Latest full-market snapshot set at/before asOf for overround display. */
export function marketPricesBefore(
  db: Db,
  matchId: number,
  marketId: number,
  asOf: string,
): Array<{ selection: string; bookmakerId: number; odds: number; takenAt: string }> {
  return db
    .prepare(
      `SELECT o.selection, o.bookmaker_id AS bookmakerId, o.decimal_odds AS odds, o.taken_at AS takenAt
       FROM odds_snapshots o
       JOIN (
         SELECT bookmaker_id, selection, MAX(taken_at) AS mt FROM odds_snapshots
         WHERE match_id = ? AND market_id = ? AND taken_at <= ?
         GROUP BY bookmaker_id, selection
       ) latest ON latest.bookmaker_id = o.bookmaker_id AND latest.selection = o.selection AND latest.mt = o.taken_at
       WHERE o.match_id = ? AND o.market_id = ?
       ORDER BY o.selection, o.bookmaker_id`,
    )
    .all(matchId, asOf, matchId, marketId, asOf) as unknown as Array<{
    selection: string;
    bookmakerId: number;
    odds: number;
    takenAt: string;
  }>;
}

export function countOdds(db: Db): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM odds_snapshots').get() as { c: number };
  return r.c;
}

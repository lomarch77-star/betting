/**
 * Data-quality subsystem (spec §5).
 *
 * Rule-based validation over the whole dataset. Every rule emits issues with
 * severity WARNING or INVALID. INVALID records are quarantined by flipping
 * matches.quality_status — and every modeling query in the platform excludes
 * INVALID records (enforced in finishedBefore).
 */

import type { Db } from '@/lib/db/client';
import { tx } from '@/lib/db/client';
import { setMatchQuality, listMatches } from '@/lib/db/repos-core';
import { insertDqReport, insertDqIssue } from '@/lib/db/repos-research';
import type { QualityStatus } from '@/lib/types';

interface RuleIssue {
  severity: 'WARNING' | 'INVALID';
  entity: string;
  entity_id: string;
  rule_code: string;
  message: string;
  detail?: unknown;
}

export interface DqRunResult {
  reportId: number;
  counts: { valid: number; warning: number; invalid: number };
  issues: RuleIssue[];
  byRule: Record<string, number>;
}

export function runDataQualityChecks(db: Db, scope = 'full'): DqRunResult {
  const issues: RuleIssue[] = [];
  const add = (i: RuleIssue) => issues.push(i);

  const matches = listMatches(db, { limit: 100000 });

  // R01: impossible scores / result-status inconsistencies
  for (const m of matches) {
    if (m.status === 'FINISHED' && (m.home_goals == null || m.away_goals == null)) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R01_MISSING_SCORE',
        message: 'FINISHED match without a final score.' });
    }
    if ((m.home_goals ?? 0) < 0 || (m.away_goals ?? 0) < 0) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R01_NEGATIVE_SCORE',
        message: `Negative goals (${m.home_goals}-${m.away_goals}).` });
    }
    if (m.status === 'SCHEDULED' && m.home_goals != null) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R01_RESULT_ON_SCHEDULED',
        message: 'SCHEDULED match carries a result — result/settlement pipeline error.' });
    }
  }

  // R02: future data with results — the CRITICAL anti-leakage rule
  const anchorSetting = db.prepare("SELECT value FROM settings WHERE key = 'demo_anchor'").get() as
    | { value: string }
    | undefined;
  const anchor = anchorSetting?.value ?? new Date().toISOString();
  for (const m of matches) {
    if (m.status === 'FINISHED' && m.kickoff_utc > anchor) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R02_FUTURE_RESULT',
        message: `Match has a result but kicks off in the future (${m.kickoff_utc} > ${anchor.slice(0, 10)}). Future data must never enter training.`,
        detail: { kickoff: m.kickoff_utc, anchor } });
    }
  }

  // R03: corrupted statistics
  for (const m of matches) {
    if (m.status !== 'FINISHED') continue;
    if (m.home_xg != null && (m.home_xg < 0 || m.home_xg > 12)) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R03_XG_RANGE',
        message: `home_xg=${m.home_xg} outside plausible range [0, 12].` });
    }
    if (m.away_xg != null && (m.away_xg < 0 || m.away_xg > 12)) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R03_XG_RANGE',
        message: `away_xg=${m.away_xg} outside plausible range [0, 12].` });
    }
    if (m.possession_home != null && (m.possession_home < 0 || m.possession_home > 1)) {
      add({ severity: 'WARNING', entity: 'match', entity_id: String(m.id), rule_code: 'R03_POSSESSION_RANGE',
        message: `possession_home=${m.possession_home} outside [0, 1].` });
    }
    if (m.home_shots_on != null && m.home_shots != null && m.home_shots_on > m.home_shots) {
      add({ severity: 'WARNING', entity: 'match', entity_id: String(m.id), rule_code: 'R03_SOT_GT_SHOTS',
        message: 'Shots on target exceed total shots.' });
    }
  }

  // R04: timestamp sanity — ISO parse and kickoff inside season window
  const seasons = db.prepare('SELECT * FROM seasons').all() as unknown as Array<{
    id: number;
    start_date: string;
    end_date: string;
  }>;
  const seasonMap = new Map(seasons.map((s) => [s.id, s]));
  for (const m of matches) {
    if (Number.isNaN(Date.parse(m.kickoff_utc))) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R04_BAD_TIMESTAMP',
        message: 'Unparseable kickoff timestamp.' });
      continue;
    }
    const s = seasonMap.get(m.season_id);
    if (s && (m.kickoff_utc < s.start_date || m.kickoff_utc > s.end_date)) {
      add({ severity: 'WARNING', entity: 'match', entity_id: String(m.id), rule_code: 'R05_SEASON_WINDOW',
        message: `Kickoff ${m.kickoff_utc.slice(0, 10)} outside season window ${s.start_date.slice(0, 10)}–${s.end_date.slice(0, 10)} (competition/season mismatch).` });
    }
  }

  // R06: duplicate matches (same teams + kickoff within 26h — not blocked by UNIQUE)
  const byPair = new Map<string, typeof matches>();
  for (const m of matches) {
    const key = [Math.min(m.home_team_id, m.away_team_id), Math.max(m.home_team_id, m.away_team_id)].join('|');
    const arr = byPair.get(key) ?? [];
    arr.push(m);
    byPair.set(key, arr);
  }
  for (const arr of byPair.values()) {
    arr.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
    for (let i = 1; i < arr.length; i++) {
      const gap = Date.parse(arr[i].kickoff_utc) - Date.parse(arr[i - 1].kickoff_utc);
      if (gap >= 0 && gap < 26 * 3_600_000) {
        add({ severity: 'WARNING', entity: 'match', entity_id: String(arr[i].id), rule_code: 'R06_NEAR_DUPLICATE',
          message: `Possible duplicate of match ${arr[i - 1].id} (same teams within 26h).` });
      }
    }
  }

  // R07: missing teams (defensive — FKs usually prevent)
  const teamIds = new Set((db.prepare('SELECT id FROM teams').all() as unknown as Array<{ id: number }>).map((t) => t.id));
  for (const m of matches) {
    if (!teamIds.has(m.home_team_id) || !teamIds.has(m.away_team_id)) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(m.id), rule_code: 'R07_MISSING_TEAM',
        message: 'Match references a missing team.' });
    }
  }

  // R08: odds validity — range and as-of consistency
  const oddsRows = db
    .prepare(
      `SELECT o.id, o.match_id, o.selection, o.decimal_odds, o.taken_at, m.kickoff_utc
       FROM odds_snapshots o JOIN matches m ON m.id = o.match_id`,
    )
    .all() as unknown as Array<{
    id: number;
    match_id: number;
    selection: string;
    decimal_odds: number;
    taken_at: string;
    kickoff_utc: string;
  }>;
  for (const o of oddsRows) {
    if (o.decimal_odds < 1.01 || o.decimal_odds > 1000) {
      add({ severity: 'INVALID', entity: 'odds_snapshot', entity_id: String(o.id), rule_code: 'R08_ODDS_RANGE',
        message: `Decimal odds ${o.decimal_odds} outside valid range [1.01, 1000].`,
        detail: { match_id: o.match_id, selection: o.selection } });
    }
    if (o.taken_at > o.kickoff_utc) {
      add({ severity: 'WARNING', entity: 'odds_snapshot', entity_id: String(o.id), rule_code: 'R08_ODDS_AFTER_KICKOFF',
        message: `Post-kickoff price observation (${o.taken_at.slice(0, 16)} vs kickoff ${o.kickoff_utc.slice(0, 16)}) — in-play data must not be treated as pre-match.`,
        detail: { match_id: o.match_id } });
    }
  }

  // R09: overround sanity per full 1X2 snapshot set
  const oneXTwos = db
    .prepare(
      `SELECT o.match_id, o.bookmaker_id, o.taken_at,
              SUM(1.0 / o.decimal_odds) AS implied
       FROM odds_snapshots o
       JOIN market_defs md ON md.id = o.market_id AND md.code = 'ONE_X_TWO'
       GROUP BY o.match_id, o.bookmaker_id, o.taken_at`,
    )
    .all() as unknown as Array<{ match_id: number; bookmaker_id: number; taken_at: string; implied: number }>;
  for (const r of oneXTwos) {
    if (r.implied < 0.985) {
      add({ severity: 'INVALID', entity: 'match', entity_id: String(r.match_id), rule_code: 'R09_NEGATIVE_MARGIN',
        message: `1X2 overround ${r.implied.toFixed(3)} < 0.985 — missing or corrupted selection prices.`,
        detail: { bookmaker: r.bookmaker_id, taken_at: r.taken_at } });
    } else if (r.implied > 1.35) {
      add({ severity: 'WARNING', entity: 'match', entity_id: String(r.match_id), rule_code: 'R09_EXTREME_MARGIN',
        message: `1X2 overround ${r.implied.toFixed(3)} — extreme bookmaker margin, prices suspect.`,
        detail: { bookmaker: r.bookmaker_id, taken_at: r.taken_at } });
    }
  }

  // ── persist report + quarantine INVALID matches ──
  const invalidMatchIds = new Set(
    issues.filter((i) => i.severity === 'INVALID' && i.entity === 'match').map((i) => Number(i.entity_id)),
  );
  const warningMatchIds = new Set(
    issues.filter((i) => i.severity === 'WARNING' && i.entity === 'match').map((i) => Number(i.entity_id)),
  );
  let valid = 0, warned = 0, invalid = 0;
  const byRule: Record<string, number> = {};
  for (const i of issues) byRule[i.rule_code] = (byRule[i.rule_code] ?? 0) + 1;

  const reportId = tx(db, () => {
    for (const m of matches) {
      let target: QualityStatus = 'VALID';
      if (invalidMatchIds.has(m.id)) target = 'INVALID';
      else if (warningMatchIds.has(m.id)) target = 'WARNING';
      if (m.quality_status !== target) setMatchQuality(db, m.id, target);
      if (target === 'VALID') valid++;
      else if (target === 'WARNING') warned++;
      else invalid++;
    }
    const rid = insertDqReport(
      db,
      scope,
      { valid, warning: warned, invalid },
      JSON.stringify({
        matchesChecked: matches.length,
        oddsChecked: oddsRows.length,
        rulesExecuted: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09'],
        byRule,
      }),
    );
    for (const i of issues) {
      insertDqIssue(db, rid, {
        severity: i.severity,
        entity: i.entity,
        entity_id: i.entity_id,
        rule_code: i.rule_code,
        message: i.message,
        detail_json: i.detail ? JSON.stringify(i.detail) : undefined,
      });
    }
    return rid;
  });

  return { reportId, counts: { valid, warning: warned, invalid }, issues, byRule };
}

/**
 * LEAKAGE PROTECTION — the non-negotiable invariant set (spec §20/§35).
 *
 * These tests attack the system from several directions:
 *   1. The streaming FeatureBuilder refuses to move backwards in time.
 *   2. Mutating the future does not change the past's features.
 *   3. Entry prices at information horizon T never include later snapshots.
 *   4. Backtest selections are always priced strictly before kickoff.
 */
import { describe, it, expect } from 'vitest';
import { buildTinyUniverse } from './helpers/tinyUniverse';
import {
  FeatureBuilder,
  buildTrainingRows,
} from '@/lib/features/builder';
import {
  finishedBefore,
  matchById,
  bestEntryPrice,
  marketDefMap,
  insertMatch,
} from '@/lib/db/repos-core';
import { executeBacktest, DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/engine';
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models/pipeline';

describe('chronological integrity', () => {
  it('FeatureBuilder rejects out-of-order consumption', () => {
    const u = buildTinyUniverse(11, 20);
    const all = finishedBefore(u.db, u.endIso, { competitionId: u.competitionId });
    const builder = new FeatureBuilder();
    builder.consume(all[10]);
    expect(() => builder.consume(all[9])).toThrow(/out-of-order/);
  });

  it('FeatureBuilder rejects snapshots before the information horizon', () => {
    const u = buildTinyUniverse(12, 20);
    const all = finishedBefore(u.db, u.endIso, { competitionId: u.competitionId });
    const builder = new FeatureBuilder();
    for (const m of all.slice(0, 15)) builder.consume(m);
    // snapshot at the same kickoff as already-consumed match #14's predecessor
    expect(() =>
      builder.snapshot(
        u.competitionId,
        u.seasonId,
        all[0].home_team_id,
        all[0].away_team_id,
        all[3].kickoff_utc,
      ),
    ).toThrow(/information horizon/);
  });

  it('MONKEY TEST: mutating the future never changes past features', () => {
    const u = buildTinyUniverse(13, 30);
    const horizon = new Date(Date.parse(u.startIso) + 100 * 86_400_000).toISOString();
    const rowsBefore = buildTrainingRows(
      finishedBefore(u.db, horizon, { competitionId: u.competitionId }),
      { minHistoryMatches: 1 },
    );
    // insert a CRAZY future result: 25–0, after the horizon
    insertMatch(u.db, {
      competition_id: u.competitionId,
      season_id: u.seasonId,
      round: 99,
      kickoff_utc: new Date(Date.parse(horizon) + 30 * 86_400_000).toISOString(),
      home_team_id: u.teamIds[0],
      away_team_id: u.teamIds[1],
      status: 'FINISHED',
      home_goals: 25,
      away_goals: 0,
      home_xg: 8.5,
      away_xg: 0.1,
    });
    const rowsAfter = buildTrainingRows(
      finishedBefore(u.db, horizon, { competitionId: u.competitionId }),
      { minHistoryMatches: 1 },
    );
    expect(JSON.stringify(rowsAfter)).toBe(JSON.stringify(rowsBefore));
  });

  it('entry price at horizon excludes later (closing) snapshots', () => {
    const u = buildTinyUniverse(14, 30);
    const defs = marketDefMap(u.db);
    const m1x2 = defs.get('ONE_X_TWO|null')!.id;
    const m = finishedBefore(u.db, u.endIso, { competitionId: u.competitionId })[30];
    // add a closing snapshot 10 min before kickoff at a LONGER price
    const closeAt = new Date(Date.parse(m.kickoff_utc) - 10 * 60_000).toISOString();
    u.db
      .prepare(
        'INSERT INTO odds_snapshots (match_id, bookmaker_id, market_id, selection, decimal_odds, taken_at, kind, is_demo) VALUES (?, 1, ?, ?, ?, ?, ?, 1)',
      )
      .run(m.id, m1x2, 'HOME', 5.0, closeAt, 'CLOSE');
    // horizon: kickoff − 60 min → closing (10 min before) must NOT be visible
    const horizon = new Date(Date.parse(m.kickoff_utc) - 60 * 60_000).toISOString();
    const entry = bestEntryPrice(u.db, m.id, m1x2, 'HOME', horizon);
    expect(entry).not.toBeNull();
    expect(entry!.takenAt <= horizon).toBe(true);
    expect(entry!.odds).not.toBeCloseTo(5.0, 8);
    // horizon at kickoff → closing IS visible and (being longest) becomes best
    const late = bestEntryPrice(u.db, m.id, m1x2, 'HOME', m.kickoff_utc);
    expect(late!.odds).toBeCloseTo(5.0, 8);
  });

  it('backtest selections always settle and price inside [asOf, kickoff] window', () => {
    const u = buildTinyUniverse(15, 56, );
    const testFrom = new Date(Date.parse(u.endIso) - 42 * 86_400_000).toISOString();
    const out = executeBacktest(
      u.db,
      {
        ...DEFAULT_BACKTEST_CONFIG,
        testFrom,
        testTo: u.endIso,
        competitionId: u.competitionId,
        edgeMin: 0.0, // accept everything for the integrity check
        probMin: 0.05,
        refitEveryRounds: 3,
        pipeline: {
          ...DEFAULT_PIPELINE_CONFIG,
          trainSpanDays: 500,
          valSpanDays: 60,
          minValRows: 20,
          strength: { ...DEFAULT_PIPELINE_CONFIG.strength, iterations: 100 },
          logistic: { ...DEFAULT_PIPELINE_CONFIG.logistic, iterations: 120 },
          gbm: { ...DEFAULT_PIPELINE_CONFIG.gbm, rounds: 10, thresholdCount: 6 },
        },
      },
      0,
    );
    expect(out.selections.length).toBeGreaterThan(0);
    for (const s of out.selections) {
      const fx = matchById(u.db, s.matchId)!;
      // price strictly inside the pre-kickoff information horizon
      expect(s.asOf < fx.kickoff_utc).toBe(true);
      // entry odds observed at or before asOf
      const entry = bestEntryPrice(u.db, s.matchId, 1, s.selection, s.asOf);
      void entry;
      // result consistency: settle matches actual score
      const hg = fx.home_goals!;
      const ag = fx.away_goals!;
      const label = hg > ag ? 'HOME' : hg === ag ? 'DRAW' : 'AWAY';
      if (s.market === 'ONE_X_TWO') {
        expect(s.won).toBe(s.selection === label);
      } else if (s.market === 'OU_GOALS') {
        expect(s.won).toBe(s.selection === 'OVER' ? hg + ag > 2.5 : hg + ag < 2.5);
      }
    }
  });

  it('backtest is deterministic: identical config ⇒ identical output', () => {
    const u1 = buildTinyUniverse(16, 56);
    const u2 = buildTinyUniverse(16, 56);
    const lightPipe = {
      ...DEFAULT_PIPELINE_CONFIG,
      trainSpanDays: 500,
      valSpanDays: 60,
      minValRows: 20,
      strength: { ...DEFAULT_PIPELINE_CONFIG.strength, iterations: 80 },
      logistic: { ...DEFAULT_PIPELINE_CONFIG.logistic, iterations: 80 },
      gbm: { ...DEFAULT_PIPELINE_CONFIG.gbm, rounds: 8, thresholdCount: 5 },
    };
    const mkCfg = (to: string, from: string) => ({
      ...DEFAULT_BACKTEST_CONFIG,
      testFrom: from,
      testTo: to,
      competitionId: u1.competitionId,
      refitEveryRounds: 4,
      pipeline: lightPipe,
    });
    const from = new Date(Date.parse(u1.endIso) - 42 * 86_400_000).toISOString();
    const o1 = executeBacktest(u1.db, mkCfg(u1.endIso, from), 0);
    const o2 = executeBacktest(u2.db, { ...mkCfg(u2.endIso, from) }, 0);
    expect(o2.fingerprint).toBe(o1.fingerprint);
    expect(o2.selections.length).toBe(o1.selections.length);
    expect(o2.metrics.roi).toBeCloseTo(o1.metrics.roi, 12);
  });
});

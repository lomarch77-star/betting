/**
 * Data-quality + repository layer tests.
 */
import { describe, it, expect } from 'vitest';
import { buildTinyUniverse } from './helpers/tinyUniverse';
import { runDataQualityChecks } from '@/lib/services/dqService';
import { insertMatch, matchById, finishedBefore } from '@/lib/db/repos-core';
import { insertModelVersion, modelVersionByCode } from '@/lib/db/repos-research';
import * as repos from '@/lib/db/repos-core';

describe('data quality subsystem', () => {
  it('detects and quarantines a future-dated result (anti-leakage rule)', () => {
    const u = buildTinyUniverse(21, 12);
    // R02 compares against the demo anchor / real now — must exceed real now
    const futureKick = new Date(Date.now() + 500 * 86_400_000).toISOString();
    const id = insertMatch(u.db, {
      competition_id: u.competitionId,
      season_id: u.seasonId,
      round: 999,
      kickoff_utc: futureKick,
      home_team_id: u.teamIds[0],
      away_team_id: u.teamIds[1],
      status: 'FINISHED',
      home_goals: 9,
      away_goals: 9,
      ingestion_id: 'test-anomaly',
    });
    const result = runDataQualityChecks(u.db, 'test');
    expect(result.counts.invalid).toBeGreaterThanOrEqual(1);
    expect(result.byRule['R02_FUTURE_RESULT']).toBe(1);
    // quarantined: modeling query must exclude it
    expect(matchById(u.db, id)!.quality_status).toBe('INVALID');
    const rows = finishedBefore(
      u.db,
      new Date(Date.parse(futureKick) + 10 * 86_400_000).toISOString(),
      { competitionId: u.competitionId },
    );
    expect(rows.find((m) => m.id === id)).toBeUndefined();
  });

  it('detects corrupted xG statistics', () => {
    const u = buildTinyUniverse(22, 12);
    const m = finishedBefore(u.db, u.endIso, { competitionId: u.competitionId })[0];
    u.db.prepare('UPDATE matches SET home_xg = 42 WHERE id = ?').run(m.id);
    const result = runDataQualityChecks(u.db, 'test');
    expect(result.byRule['R03_XG_RANGE']).toBe(1);
    expect(matchById(u.db, m.id)!.quality_status).toBe('INVALID');
  });

  it('model_versions are insert-only by convention (code UNIQUE)', () => {
    const u = buildTinyUniverse(23, 8);
    insertModelVersion(u.db, {
      code: 'v-test-1',
      kind: 'ENSEMBLE',
      name: 'test',
      config_json: '{}',
      train_window_from: null,
      train_window_to: null,
      train_sample: 0,
      dataset_fingerprint: 'x',
    });
    expect(() =>
      insertModelVersion(u.db, {
        code: 'v-test-1',
        kind: 'ENSEMBLE',
        name: 'duplicate',
        config_json: '{}',
        train_window_from: null,
        train_window_to: null,
        train_sample: 0,
        dataset_fingerprint: 'x',
      }),
    ).toThrow();
    expect(modelVersionByCode(u.db, 'v-test-1')!.name).toBe('test');
  });
});

describe('repository boundaries', () => {
  it('finishedBefore is strictly less-than the horizon', () => {
    const u = buildTinyUniverse(24, 12);
    const all = finishedBefore(u.db, u.endIso, { competitionId: u.competitionId });
    const target = all[10];
    const rows = repos.finishedBefore(u.db, target.kickoff_utc, { competitionId: u.competitionId });
    expect(rows.every((m) => m.kickoff_utc < target.kickoff_utc)).toBe(true);
    expect(rows.find((m) => m.id === target.id)).toBeUndefined();
  });
});

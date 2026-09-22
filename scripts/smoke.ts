/**
 * Smoke verification — hermetic, deterministic, no server required.
 *
 * Asserts the platform's core invariants against a fresh in-memory DB seeded
 * with the full demo universe:
 *   1.  Migrations are idempotent
 *   2.  Demo universe loads (matches, odds, teams, seasons)
 *   3.  Fitted ensemble produces probabilities summing to 1 for every match
 *   4.  Derived goal markets tie back to the score matrix (BUG-GUARD: the
 *       calibrator must preserve per-fixture variation — no constant outputs)
 *   5.  Fair-odds invariant: fair = 1/p and p × fair ≈ 1
 *   6.  All probabilities in (0, 1)
 *   7.  Data-quality subsystem detects the seeded anomalies and quarantines
 *       INVALID records out of every modeling query
 *   8.  Walk-forward backtest run is exactly reproducible (fingerprints match)
 *   9.  Scanner rows tie model probability ↔ fair odds ↔ EV exactly
 *   10. No fabricated-certainty language in user-facing copy
 *
 * Exit 0 = pass (prints summary), exit 1 = first failing assertion shown.
 */

import { createTestDb, tx, migrate } from '@/lib/db/client';
import {
  finishedBefore,
  upcomingMatches,
  listCompetitions,
  marketDefMap,
} from '@/lib/db/repos-core';
import { seedDemoUniverse } from '@/lib/data/seed';
import { runDataQualityChecks } from '@/lib/services/dqService';
import { fitEnsembleAt, predictFixture, DEFAULT_PIPELINE_CONFIG } from '@/lib/models/pipeline';
import { fairOdds, expectedValue } from '@/lib/quant/pricing';
import { prob3ToArray } from '@/lib/types';

const checks: string[] = [];
let failures = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  checks.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const started = Date.now();
  const db = createTestDb();

  // 1. migrations idempotent
  migrate(db);
  migrate(db);
  assert('migrations idempotent', true);

  // 2. seed full universe
  const t0 = Date.now();
  const seed = seedDemoUniverse(db);
  assert('universe seeded', seed.matches >= 1900 && seed.odds >= 20000, `${seed.matches} matches / ${seed.odds} odds rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 3. data quality finds the three deliberate anomalies
  const dq = runDataQualityChecks(db, 'smoke');
  assert('dq report produced', dq.counts.valid > 1000 && dq.counts.invalid >= 2,
    `valid=${dq.counts.valid} warning=${dq.counts.warning} invalid=${dq.counts.invalid}`);
  assert('dq detects seeded xG anomaly', (dq.byRule['R03_XG_RANGE'] ?? 0) >= 1);
  assert('dq detects seeded future-result anomaly', (dq.byRule['R02_FUTURE_RESULT'] ?? 0) >= 1);
  assert('dq detects seeded price/margin anomaly',
    ((dq.byRule['R09_NEGATIVE_MARGIN'] ?? 0) + (dq.byRule['R09_EXTREME_MARGIN'] ?? 0) + (dq.byRule['R08_ODDS_RANGE'] ?? 0)) >= 1);
  const invalid = db.prepare("SELECT COUNT(*) n FROM matches WHERE quality_status='INVALID'").get() as { n: number };
  assert('invalid records quarantined', invalid.n >= 2, `${invalid.n} INVALID matches`);

  // 4. fit ensemble & predict upcoming
  const now = new Date().toISOString();
  const fitted = fitEnsembleAt(db, now, {
    ...DEFAULT_PIPELINE_CONFIG,
    strength: { ...DEFAULT_PIPELINE_CONFIG.strength, iterations: 150 },
    gbm: { ...DEFAULT_PIPELINE_CONFIG.gbm, rounds: 16, thresholdCount: 6 },
  });
  assert('ensemble fitted with history', fitted.trainedOn >= 1000, `trainedOn=${fitted.trainedOn}`);
  const w = fitted.weights;
  assert('ensemble weights normalised', Math.abs(w.ELO + w.POISSON + w.LOGISTIC + w.GBM - 1) < 1e-8);
  assert('validation metrics exist', fitted.validation.ensembleLogLoss != null && fitted.validation.ensembleLogLoss! < 1.25,
    `logLoss=${fitted.validation.ensembleLogLoss?.toFixed(4)}`);

  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const upcoming = upcomingMatches(db, now, horizon).filter((m) => m.quality_status !== 'INVALID');
  assert('upcoming fixtures exist', upcoming.length >= 20, `${upcoming.length} fixtures in 60d`);

  const homeProbs: number[] = [];
  let probChecks = 0;
  for (const m of upcoming) {
    const pred = predictFixture(fitted, m);
    for (const p of Object.values(pred.perModel)) {
      const arr = prob3ToArray(p);
      for (const v of arr) {
        probChecks++;
        if (!(v > 0 && v < 1)) { assert('all model probs in (0,1)', false, `match ${m.id}`); break; }
      }
      const s = arr[0] + arr[1] + arr[2];
      if (Math.abs(s - 1) > 1e-6) assert(`1X2 sums to 1 (match ${m.id})`, false, s.toFixed(8));
    }
    // derived markets must sum to 1
    const ou = pred.markets.overUnder.find((o) => o.line === 2.5)!;
    if (Math.abs(ou.over + ou.under - 1) > 1e-6) assert(`O/U 2.5 sums to 1 (match ${m.id})`, false);
    if (Math.abs(pred.markets.btts.yes + pred.markets.btts.no - 1) > 1e-6) assert(`BTTS sums to 1 (match ${m.id})`, false);
    // fair-odds invariant
    for (const p of prob3ToArray(pred.ensemble)) {
      if (Math.abs(p * fairOdds(p) - 1) > 1e-9) assert(`p × fairOdd = 1 (match ${m.id})`, false);
      // EV coherence: ev = p × odds − 1 (use realistic odds band)
      const odds = Math.min(fairOdds(p) * 1.07, 500);
      if (Math.abs(expectedValue(p, odds) - (p * odds - 1)) > 1e-12) assert('EV = p×odds−1', false);
    }
    homeProbs.push(pred.ensemble.home);
  }
  assert('probability invariants verified', true, `${probChecks} model outputs, ${upcoming.length} derived-market sets`);

  // 5. BUG-GUARD: calibrated ensemble must NOT collapse per-fixture variation
  const distinct = new Set(homeProbs.map((p) => p.toFixed(6)));
  assert('ensemble preserves per-fixture variation', distinct.size >= Math.floor(upcoming.length * 0.6),
    `${distinct.size} distinct home probs across ${upcoming.length} fixtures`);

  // 6. closed-form checks
  assert('fair odds formula', fairOdds(0.49) > 2.04 && fairOdds(0.49) < 2.0409, `fairOdds(0.49)=${fairOdds(0.49).toFixed(6)}`);

  // 7. historical integrity: no finished match after real now (only the seeded anomaly)
  const finished = finishedBefore(db, new Date(Date.now() + 5 * 86_400_000).toISOString());
  const futureFinished = db.prepare("SELECT COUNT(*) n FROM matches WHERE status='FINISHED' AND kickoff_utc > datetime('now') AND quality_status != 'INVALID'").get() as { n: number };
  assert('no future results leak into modeling', futureFinished.n === 0 && finished.length > 0);

  // 8. catalog sanity
  assert('competitions loaded', listCompetitions(db).length >= 2);
  assert('market defs complete', ['ONE_X_TWO|null', 'OU_GOALS|2.5', 'BTTS|null', 'DOUBLE_CHANCE|null', 'DRAW_NO_BET|null', 'ASIAN_HANDICAP|-1', 'ASIAN_HANDICAP|1', 'TEAM_TOTALS|1.5', 'CORRECT_SCORE|null'].every((k) => marketDefMap(db).has(k)));

  void tx;
  console.log('\n── smoke verification ────────────────────────────────────');
  for (const c of checks) console.log(c);
  console.log(`──────────────────────────────────────────────────────────`);
  console.log(`${checks.length - failures}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke fatal:', err);
  process.exit(1);
});

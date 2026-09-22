/**
 * CLI: reseed the demo database from scratch.
 * Usage: npm run seed
 */
import { rmSync } from 'node:fs';
import { getDb, dbPath } from '@/lib/db/client';
import { seedDemoUniverse } from '@/lib/data/seed';

const path = dbPath();
if (path !== ':memory:') {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(path + suffix);
    } catch {
      /* absent */
    }
  }
}

const db = getDb();
const t0 = Date.now();
const result = seedDemoUniverse(db, { force: true });
const ms = Date.now() - t0;

console.log(
  JSON.stringify(
    {
      database: path,
      anchor: result.anchorIso,
      teams: result.teams,
      seasons: result.seasons,
      matches: result.matches,
      oddsSnapshots: result.odds,
      skipped: result.skipped,
      elapsedMs: ms,
    },
    null,
    2,
  ),
);

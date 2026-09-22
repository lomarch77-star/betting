import { rmSync } from 'node:fs';
import { POST_, ok } from '@/lib/api-helpers';
import { dbPath } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * Admin: wipe and regenerate the demo universe from scratch.
 * Destructive to DEMO data only (this deployment has no non-demo data).
 */
export const POST = POST_('admin', 'RESEED_DEMO', 'database', async () => {
  const path = dbPath();
  const { _setSingletonForTests, getDb } = await import('@/lib/db/client');
  const current = getDb();
  try {
    current.close();
  } catch {
    /* ok */
  }
  _setSingletonForTests(null);
  if (path !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) rmSyncSafe(path + suffix);
  }
  const { seedDemoUniverse } = await import('@/lib/data/seed');
  const { invalidateStandardCache } = await import('@/lib/services/predictionService');
  const { runDataQualityChecks } = await import('@/lib/services/dqService');
  const db = getDb();
  invalidateStandardCache();
  const result = seedDemoUniverse(db, { force: true });
  const dq = runDataQualityChecks(db);
  return ok({ seed: result, dataQuality: dq.counts }, { database: path });
});

function rmSyncSafe(p: string): void {
  try {
    rmSync(p);
  } catch {
    /* absent */
  }
}

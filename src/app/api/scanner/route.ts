import { z } from 'zod';
import { GET_, ok } from '@/lib/api-helpers';
import { runScanner } from '@/lib/services/scannerService';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

const Query = z.object({
  market: z.enum(['ONE_X_TWO', 'OU_GOALS', 'BTTS']).optional(),
  competitionId: z.coerce.number().int().positive().optional(),
  minAbsDiffPct: z.coerce.number().min(0).max(5).optional(),
  minEv: z.coerce.number().min(-1).max(5).optional(),
  agreement: z.enum(['BROAD', 'MODERATE', 'SPLIT']).optional(),
  quality: z.enum(['VALID', 'WARNING']).optional(),
  sortBy: z.enum(['diffPct', 'ev', 'modelProbability', 'kickoff']).default('diffPct'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const GET = GET_(async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail(400, 'BAD_QUERY', parsed.error.issues[0].message);
  const rows = await runScanner(ctx.db, parsed.data);
  return ok(rows, {
    count: rows.length,
    note: 'Sorted by measurable fields only. Differences are research signals, never recommendations.',
  });
});

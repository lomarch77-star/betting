import { z } from 'zod';
import { GET_, POST_, ok } from '@/lib/api-helpers';
import { portfolioReport, addPaperEntry, settleDueEntries } from '@/lib/services/portfolioService';
import { matchById, marketDefMap, bestEntryPrice } from '@/lib/db/repos-core';
import { fail } from '@/lib/http';
import { isValidDecimalOdds } from '@/lib/quant/pricing';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  const report = portfolioReport(ctx.db);
  return ok(report, {
    note: 'Simulated paper ledger only. No real-money execution exists in this product.',
  });
});

const PostBody = z.object({
  matchId: z.number().int().positive(),
  market: z.enum(['ONE_X_TWO', 'OU_GOALS', 'BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET']),
  line: z.number().min(0.5).max(5.5).nullable().default(null),
  selection: z.string().min(2).max(20),
  odds: z.number(),
  modelProbability: z.number().min(0.001).max(0.999),
  modelVersionId: z.number().int().positive().nullable().default(null),
  stake: z.number().positive().max(100).default(1),
  notes: z.string().max(500).optional(),
});

export const POST = POST_('researcher', 'ADD_PAPER_ENTRY', 'paper_entry', async (req, ctx) => {
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'BAD_BODY', parsed.error?.issues[0]?.message ?? 'invalid body');
  const b = parsed.data;
  const m = matchById(ctx.db, b.matchId);
  if (!m) return fail(404, 'NOT_FOUND', `No match ${b.matchId}`);
  if (m.status !== 'SCHEDULED') {
    return fail(409, 'MATCH_STARTED', 'Paper entries are only accepted before kickoff — the ledger must never be filled with post-hoc prices.');
  }
  if (!isValidDecimalOdds(b.odds)) return fail(400, 'BAD_ODDS', 'Decimal odds outside [1.01, 1000]');

  // guard: entry odds must not exceed a plausible best price (+8% tolerance)
  const defs = marketDefMap(ctx.db);
  const marketId = defs.get(`${b.market}|${b.line}`)?.id;
  if (marketId) {
    const best = bestEntryPrice(ctx.db, b.matchId, marketId, b.selection, new Date().toISOString());
    if (best && b.odds > best.odds * 1.08) {
      return fail(
        409,
        'UNREALISTIC_PRICE',
        `Claimed odds ${b.odds} exceed best available ${best.odds} by >8% — paper ledger records must reflect obtainable prices.`,
      );
    }
  }
  const id = addPaperEntry(ctx.db, {
    matchId: b.matchId,
    market: b.market,
    line: b.line,
    selection: b.selection,
    bookmaker: 'manual',
    odds: b.odds,
    modelProbability: b.modelProbability,
    modelVersionId: b.modelVersionId,
    stake: b.stake,
    notes: b.notes,
  });
  settleDueEntries(ctx.db);
  return ok({ id });
});

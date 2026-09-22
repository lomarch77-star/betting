import { z } from 'zod';
import { GET_, POST_, ok } from '@/lib/api-helpers';
import { listBacktestRuns } from '@/lib/db/repos-research';
import { runBacktestAsync, defaultBacktestConfig } from '@/lib/services/backtestService';
import { DEFAULT_BACKTEST_CONFIG } from '@/lib/backtest/engine';
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models/pipeline';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  const runs = listBacktestRuns(ctx.db).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    summary: r.metrics_json
      ? (() => {
          const m = JSON.parse(r.metrics_json);
          return {
            testMatches: m.testMatches,
            refits: m.refits,
            selections: m.betting?.selections,
            roi: m.betting?.roi,
            maxDrawdownPct: m.betting?.maxDrawdownPct,
            logLoss: m.prediction?.logLoss,
            brier: m.prediction?.brier,
            ece: m.calibration?.ece,
            beatCloseRate: m.betting?.clv?.beatCloseRate ?? null,
            fingerprint: m.fingerprint,
          };
        })()
      : null,
  }));
  return ok(runs);
});

const PostBody = z.object({
  name: z.string().min(3).max(200).optional(),
  testFrom: z.string().datetime({ offset: true }),
  testTo: z.string().datetime({ offset: true }),
  competitionId: z.number().int().positive().nullable().default(null),
  refitEveryRounds: z.number().int().min(1).max(10).default(3),
  markets: z
    .array(
      z.object({
        code: z.enum(['ONE_X_TWO', 'OU_GOALS']),
        line: z.number().min(0.5).max(5.5).optional(),
      }),
    )
    .min(1)
    .default([{ code: 'ONE_X_TWO' }, { code: 'OU_GOALS', line: 2.5 }]),
  edgeMin: z.number().min(0).max(0.5).default(0.04),
  probMin: z.number().min(0.01).max(0.9).default(0.15),
  skipWhenSplit: z.boolean().default(false),
  entryPrice: z.enum(['best', 'consensus']).default('best'),
  stakeMode: z.enum(['flat', 'kelly']).default('flat'),
});

export const POST = POST_('researcher', 'REQUEST_BACKTEST', 'backtest_run', async (req, ctx) => {
  const body = await req.json().catch(() => null);
  if (!body) {
    // no body → run the platform default
    const cfg = defaultBacktestConfig(ctx.db);
    const runId = runBacktestAsync(ctx.db, cfg, ctx.actor);
    return ok({ runId, config: cfg }, { mode: 'default' });
  }
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) return fail(400, 'BAD_BODY', parsed.error.issues[0].message);
  const b = parsed.data;
  if (Date.parse(b.testFrom) >= Date.parse(b.testTo)) {
    return fail(400, 'BAD_WINDOW', 'testFrom must be before testTo');
  }
  const cfg = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: b.name ?? `Custom run ${b.testFrom.slice(0, 10)} → ${b.testTo.slice(0, 10)}`,
    competitionId: b.competitionId,
    testFrom: b.testFrom,
    testTo: b.testTo,
    refitEveryRounds: b.refitEveryRounds,
    markets: b.markets as never,
    edgeMin: b.edgeMin,
    probMin: b.probMin,
    skipWhenSplit: b.skipWhenSplit,
    entryPrice: b.entryPrice,
    stakeMode: b.stakeMode,
    pipeline: DEFAULT_PIPELINE_CONFIG,
  };
  const runId = runBacktestAsync(ctx.db, cfg, ctx.actor);
  return ok({ runId, config: cfg });
});

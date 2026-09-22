import { z } from 'zod';
import { GET_, POST_, ok } from '@/lib/api-helpers';
import { listExperiments } from '@/lib/db/repos-research';
import { createExperiment } from '@/lib/services/experimentService';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  return ok(
    listExperiments(ctx.db).map((e) => ({
      id: e.id,
      code: e.code,
      title: e.title,
      hypothesis: e.hypothesis,
      status: e.status,
      config: JSON.parse(e.config_json),
      metrics: e.metrics_json ? JSON.parse(e.metrics_json) : null,
      resultText: e.result_text,
      createdBy: e.created_by,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    })),
  );
});

const Filter = z.object({
  feature: z.string().min(2).max(40),
  op: z.enum(['>=', '<=', 'between']),
  value: z.number(),
  value2: z.number().optional(),
});

const PostBody = z.object({
  title: z.string().min(5).max(200),
  hypothesis: z.string().min(10).max(2000),
  config: z.object({
    dataset: z.object({
      competitionId: z.number().int().positive().nullable().default(null),
      testFrom: z.string().datetime({ offset: true }),
      testTo: z.string().datetime({ offset: true }),
      trainSpanDays: z.number().int().min(120).max(2200).default(760),
    }),
    market: z.enum(['ONE_X_TWO', 'OU_GOALS']).default('ONE_X_TWO'),
    line: z.number().min(0.5).max(5.5).optional(),
    matchFilters: z.array(Filter).max(5).default([]),
    methodology: z
      .object({
        refitEveryRounds: z.number().int().min(1).max(10).default(4),
        edgeMin: z.number().min(0).max(0.5).default(0.01),
        entryPrice: z.enum(['best', 'consensus']).default('best'),
        calibrationMethod: z.enum(['platt', 'isotonic']).default('isotonic'),
      })
      .default({ refitEveryRounds: 4, edgeMin: 0.01, entryPrice: 'best', calibrationMethod: 'isotonic' }),
  }),
});

export const POST = POST_('researcher', 'CREATE_EXPERIMENT', 'experiment', async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'BAD_BODY', parsed.error?.issues[0]?.message ?? 'invalid JSON body');
  }
  const id = createExperiment(ctx.db, {
    title: parsed.data.title,
    hypothesis: parsed.data.hypothesis,
    config: parsed.data.config as never,
    createdBy: ctx.actor,
  });
  return ok({ id });
});

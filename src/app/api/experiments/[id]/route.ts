import { GET_, ok } from '@/lib/api-helpers';
import { experimentById } from '@/lib/db/repos-research';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-1));
  const e = experimentById(ctx.db, id);
  if (!e) return fail(404, 'NOT_FOUND', `No experiment ${id}`);
  return ok({
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
  });
});

import { z } from 'zod';
import { GET_, PATCH_, ok } from '@/lib/api-helpers';
import { edgeById, updateEdge } from '@/lib/db/repos-research';
import { fail, HttpError } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-1));
  const e = edgeById(ctx.db, id);
  if (!e) return fail(404, 'NOT_FOUND', `No edge ${id}`);
  return ok({ ...e, metrics: e.metrics_json ? JSON.parse(e.metrics_json) : null });
});

const ALLOWED: Record<string, string[]> = {
  UNTESTED: ['VALIDATING', 'REJECTED', 'RETIRED'],
  PROMISING: ['VALIDATING', 'REJECTED', 'RETIRED'],
  VALIDATING: ['PASSED', 'REJECTED', 'RETIRED'],
  PASSED: ['RETIRED', 'VALIDATING'],
  REJECTED: ['VALIDATING', 'RETIRED'],
  RETIRED: [],
};

const PatchBody = z.object({
  status: z.enum(['UNTESTED', 'PROMISING', 'VALIDATING', 'PASSED', 'REJECTED', 'RETIRED']),
});

/** Status transitions are deliberately restricted — no silent promotion. */
export const PATCH = PATCH_('researcher', 'TRANSITION_EDGE', 'edge', async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-1));
  const e = edgeById(ctx.db, id);
  if (!e) return fail(404, 'NOT_FOUND', `No edge ${id}`);
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'BAD_BODY', 'Expected { status }');
  const next = parsed.data.status;
  if (!(ALLOWED[e.status] ?? []).includes(next)) {
    throw new HttpError(
      409,
      'ILLEGAL_TRANSITION',
      `Edge status cannot move ${e.status} → ${next}. Allowed: ${(ALLOWED[e.status] ?? []).join(', ') || 'none'}.`,
    );
  }
  updateEdge(ctx.db, id, { status: next });
  return ok({ id, status: next });
});

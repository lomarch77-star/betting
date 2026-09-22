import { GET_, ok } from '@/lib/api-helpers';
import { listAudit } from '@/lib/db/repos-research';
import { resolveAuth, requireRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (req, ctx) => {
  requireRole(resolveAuth(req), 'admin');
  return ok(listAudit(ctx.db, 300));
});

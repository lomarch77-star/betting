/**
 * Shared wrapper for API route handlers: bootstrap → rate limit → auth →
 * role gate → execute → uniform error mapping. Mutations are audit-logged.
 */

import { resolveAuth, requireRole, type AuthContext } from './auth';
import { rateLimitOrThrow, toResponse, ok } from './http';
import { ensureBootstrapped } from './bootstrap';
import { getDb } from './db/client';
import { audit } from './db/repos-research';
import type { Role } from '@/lib/types';

export type RouteCtx = AuthContext & { db: ReturnType<typeof getDb> };

export function GET_(fn: (req: Request, ctx: RouteCtx) => Promise<Response> | Response) {
  return withOps(fn, 'reader', null);
}

export function POST_(
  minRole: Role,
  action: string,
  entity: string,
  fn: (req: Request, ctx: RouteCtx) => Promise<Response> | Response,
) {
  return withOps(fn, minRole, { action, entity });
}

export function PATCH_(
  minRole: Role,
  action: string,
  entity: string,
  fn: (req: Request, ctx: RouteCtx) => Promise<Response> | Response,
) {
  return withOps(fn, minRole, { action, entity });
}

function withOps(
  fn: (req: Request, ctx: RouteCtx) => Promise<Response> | Response,
  minRole: Role,
  auditSpec: { action: string; entity: string } | null,
) {
  return async (req: Request): Promise<Response> => {
    try {
      ensureBootstrapped();
      rateLimitOrThrow(req);
      const auth = resolveAuth(req);
      requireRole(auth, minRole);
      const db = getDb();
      const res = await fn(req, { ...auth, db });
      if (auditSpec) {
        audit(db, {
          actor: auth.actor,
          role: auth.role,
          action: auditSpec.action,
          entity: auditSpec.entity,
          detail: { path: new URL(req.url).pathname },
        });
      }
      return res;
    } catch (err) {
      return toResponse(err);
    }
  };
}

export { ok };
export const dynamic = 'force-dynamic';

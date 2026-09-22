/**
 * API access control (spec §36).
 *
 * Role model:
 *   reader     — all GET read endpoints
 *   researcher — + backtests, experiments, edge status, paper portfolio
 *   admin      — + reseed, audit log access
 *
 * Keys are read from the environment ONLY (never committed). If no keys are
 * configured the app runs in DEMO_AUTH_MODE: mutations are allowed, but
 * every mutation is audit-logged under actor "demo-operator" and the mode is
 * surfaced on the settings page.
 */

import type { Role } from '@/lib/types';

export interface AuthContext {
  actor: string;
  role: Role;
  demoAuthMode: boolean;
}

const RANK: Record<Role, number> = { reader: 0, researcher: 1, admin: 2 };

export function resolveAuth(req: Request): AuthContext {
  const researchKey = process.env.RESEARCH_API_KEY ?? '';
  const adminKey = process.env.ADMIN_API_KEY ?? '';
  const presented = req.headers.get('x-api-key') ?? '';

  const keysConfigured = researchKey.length > 0 || adminKey.length > 0;

  if (!keysConfigured) {
    return { actor: 'demo-operator', role: 'admin', demoAuthMode: true };
  }
  if (presented && presented === adminKey) {
    return { actor: 'admin-key', role: 'admin', demoAuthMode: false };
  }
  if (presented && presented === researchKey) {
    return { actor: 'research-key', role: 'researcher', demoAuthMode: false };
  }
  return { actor: 'anonymous', role: 'reader', demoAuthMode: false };
}

export class ForbiddenError extends Error {
  status = 403;
  code = 'FORBIDDEN';
  constructor(min: Role) {
    super(`This endpoint requires role ≥ ${min}.`);
  }
}

export function requireRole(ctx: AuthContext, min: Role): void {
  if (RANK[ctx.role] < RANK[min]) throw new ForbiddenError(min);
}

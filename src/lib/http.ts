/**
 * API plumbing: uniform JSON envelopes, rate limiting, error mapping.
 */

import { ForbiddenError } from './auth';

export function ok(data: unknown, meta?: Record<string, unknown>): Response {
  return Response.json({ data, meta: meta ?? {} });
}

export function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toResponse(err: unknown): Response {
  if (err instanceof ForbiddenError) return fail(403, err.code, err.message);
  if (err instanceof HttpError) return fail(err.status, err.code, err.message);
  const msg = err instanceof Error ? err.message : String(err);
  return fail(500, 'INTERNAL', msg.length > 300 ? msg.slice(0, 300) : msg);
}

// ─── token-bucket rate limiting (per key, in-process) ────────────────────────

interface Bucket {
  tokens: number;
  refreshedAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimited(key: string, perMinute: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: perMinute, refreshedAt: now };
    buckets.set(key, b);
  }
  const refill = ((now - b.refreshedAt) / 60_000) * perMinute;
  if (refill > 0) {
    b.tokens = Math.min(perMinute, b.tokens + refill);
    b.refreshedAt = now;
  }
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  // housekeeping: bound map size
  if (buckets.size > 5000) buckets.clear();
  return false;
}

export function rateLimitOrThrow(req: Request): void {
  const limit = Number(process.env.API_RATE_LIMIT_PER_MIN ?? 240);
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local';
  if (rateLimited(ip, limit)) {
    throw new HttpError(429, 'RATE_LIMITED', `Rate limit exceeded (${limit}/min).`);
  }
}

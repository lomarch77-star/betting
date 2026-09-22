import { GET_, ok } from '@/lib/api-helpers';
import { dashboardSummary } from '@/lib/services/dashboardService';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => ok(await dashboardSummary(ctx.db)));

import { GET_, ok } from '@/lib/api-helpers';
import { listCompetitions, listSeasons, listBookmakers, listMarketDefs } from '@/lib/db/repos-core';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) =>
  ok({
    competitions: listCompetitions(ctx.db),
    seasons: listSeasons(ctx.db),
    bookmakers: listBookmakers(ctx.db),
    markets: listMarketDefs(ctx.db),
    demoData: true,
  }),
);

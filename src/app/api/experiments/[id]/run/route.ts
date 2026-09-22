import { POST_, ok } from '@/lib/api-helpers';
import { runExperimentAsync } from '@/lib/services/experimentService';
import { experimentById, setExperimentStatus } from '@/lib/db/repos-research';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Trigger a (re)run of an experiment — executes as a detached job. */
export const POST = POST_('researcher', 'RUN_EXPERIMENT', 'experiment', async (req, ctx) => {
  const id = Number(new URL(req.url).pathname.split('/').at(-2));
  const e = experimentById(ctx.db, id);
  if (!e) return fail(404, 'NOT_FOUND', `No experiment ${id}`);
  setExperimentStatus(ctx.db, id, 'VALIDATING');
  runExperimentAsync(ctx.db, id, ctx.actor);
  return ok({ id, status: 'RUNNING' });
});

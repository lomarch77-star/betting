import { GET_, POST_, ok } from '@/lib/api-helpers';
import { latestDqReport, dqIssuesForReport } from '@/lib/db/repos-research';
import { runDataQualityChecks } from '@/lib/services/dqService';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  const report = latestDqReport(ctx.db);
  if (!report) return ok({ report: null, issues: [] });
  return ok({
    report: {
      id: report.id,
      runAt: report.run_at,
      scope: report.scope,
      valid: report.valid_count,
      warnings: report.warning_count,
      invalid: report.invalid_count,
      summary: JSON.parse(report.summary_json),
    },
    issues: dqIssuesForReport(ctx.db, report.id),
  });
});

export const POST = POST_('researcher', 'RERUN_DQ', 'data_quality_report', async (_req, ctx) => {
  const result = runDataQualityChecks(ctx.db);
  return ok({
    reportId: result.reportId,
    counts: result.counts,
    byRule: result.byRule,
  });
});

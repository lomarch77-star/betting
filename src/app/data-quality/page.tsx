import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { latestDqReport, dqIssuesForReport } from '@/lib/db/repos-research';
import { Panel, Kpi, Notice } from '@/components/ui';
import { RunDqButton } from '@/components/run-dq';
import { fmtInt, fmtDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const RULE_NAMES: Record<string, string> = {
  R01_MISSING_SCORE: 'Finished match without score',
  R01_NEGATIVE_SCORE: 'Negative goals',
  R01_RESULT_ON_SCHEDULED: 'Result on scheduled match',
  R02_FUTURE_RESULT: 'Future data with result (anti-leakage)',
  R03_XG_RANGE: 'xG outside plausible range',
  R03_POSSESSION_RANGE: 'Possession outside [0,1]',
  R03_SOT_GT_SHOTS: 'Shots-on-target > shots',
  R04_BAD_TIMESTAMP: 'Unparseable kickoff timestamp',
  R05_SEASON_WINDOW: 'Kickoff outside season window',
  R06_NEAR_DUPLICATE: 'Near-duplicate match',
  R07_MISSING_TEAM: 'Missing team reference',
  R08_ODDS_RANGE: 'Odds outside [1.01, 1000]',
  R08_ODDS_AFTER_KICKOFF: 'Price observed after kickoff',
  R09_NEGATIVE_MARGIN: '1X2 overround < 0.985',
  R09_EXTREME_MARGIN: '1X2 overround extreme',
};

export default async function DataQualityPage() {
  ensureBootstrapped();
  const db = getDb();
  const report = latestDqReport(db);
  const issues = report ? dqIssuesForReport(db, report.id) : [];
  const summary = report ? JSON.parse(report.summary_json) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Data Quality Subsystem</div>
          <div className="page-sub">
            Rule-based validation with quarantine: INVALID records never reach model training
            (enforced by every modeling query), WARNINGs surface uncertainty.
          </div>
        </div>
        <RunDqButton />
      </div>

      {!report ? (
        <Notice kind="info">No data-quality report yet.</Notice>
      ) : (
        <>
          <div className="grid cols-4">
            <Kpi label="Records Valid" value={fmtInt(report.valid_count)} tone="good" sub={fmtDateTime(report.run_at)} />
            <Kpi label="Warnings" value={fmtInt(report.warning_count)} tone="warn" sub="usable, flagged" />
            <Kpi label="Invalid (Quarantined)" value={fmtInt(report.invalid_count)} tone="bad" sub="excluded from modeling" />
            <Kpi label="Rules Executed" value={fmtInt(summary?.rulesExecuted?.length ?? 0)} sub={`${fmtInt(summary?.matchesChecked)} matches · ${fmtInt(summary?.oddsChecked)} odds rows checked`} />
          </div>

          <div style={{ height: 14 }} />
          <Panel title="Rule Findings">
            <table className="data">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Description</th>
                  <th className="num">Findings</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(summary?.byRule ?? {}).map(([rule, n]) => (
                  <tr key={rule}>
                    <td className="num strong">{rule}</td>
                    <td className="small dim">{RULE_NAMES[rule] ?? rule}</td>
                    <td className={`num ${String(rule).includes('FUTURE') ? 'neg' : Number(n) > 2 ? 'amber' : ''}`}>{fmtInt(Number(n))}</td>
                  </tr>
                ))}
                {Object.keys(summary?.byRule ?? {}).length === 0 && (
                  <tr><td colSpan={3} className="muted-box">No findings — dataset fully valid.</td></tr>
                )}
              </tbody>
            </table>
          </Panel>

          <div style={{ height: 14 }} />
          <Panel title={`Issue Log (${issues.length}) — latest report`} flush>
            <div className="table-wrap scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Rule</th>
                    <th>Entity</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <span className={`badge ${i.severity === 'INVALID' ? 'bad' : 'warn'}`}>{i.severity}</span>
                      </td>
                      <td className="num">{i.rule_code}</td>
                      <td className="small dim">
                        {i.entity} #{i.entity_id}
                      </td>
                      <td className="small" style={{ whiteSpace: 'normal', maxWidth: 640 }}>
                        {i.message}
                      </td>
                    </tr>
                  ))}
                  {issues.length === 0 && (
                    <tr><td colSpan={4} className="muted-box">No issues in the latest report.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-body">
              <div className="micro faint">
                The demo universe deliberately contains three seeded anomalies (corrupted xG, a
                future-dated "result", an extreme-margin price set) — visible above as proof the
                detection pipeline works end-to-end. They are quarantined and never influence models.
              </div>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

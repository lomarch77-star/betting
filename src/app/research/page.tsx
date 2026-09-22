import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { listExperiments } from '@/lib/db/repos-research';
import { Panel, Notice } from '@/components/ui';
import { ExperimentForm } from '@/components/experiment-form';
import { fmtPct, fmtNum, fmtInt, fmtDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ResearchPage() {
  ensureBootstrapped();
  const db = getDb();
  const experiments = listExperiments(db);
  const bounds = db
    .prepare("SELECT MIN(start_date) AS mn, MAX(end_date) AS mx FROM seasons WHERE status = 'FINISHED'")
    .get() as { mn: string; mx: string };
  const defaultFrom = (() => {
    // default OOS window: last two completed seasons
    const rows = db
      .prepare("SELECT start_date FROM seasons WHERE status='FINISHED' ORDER BY start_date DESC LIMIT 1 OFFSET 1")
      .get() as { start_date: string } | undefined;
    return (rows?.start_date ?? bounds.mn).slice(0, 10);
  })();
  const defaultTo = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Research Lab</div>
          <div className="page-sub">
            Hypothesis-driven edge discovery. Every experiment IS a reproducible walk-forward
            backtest with the platform's chronological-integrity guarantees.
          </div>
        </div>
      </div>

      <Notice kind="warn">
        A positive historical ROI does not establish an edge. Statuses reflect sample size,
        out-of-sample behaviour and calibration — promotion of an edge is a human decision recorded
        in the registry.
      </Notice>
      <div style={{ height: 14 }} />

      <Panel title="Create Experiment">
        <ExperimentForm defaultFrom={defaultFrom} defaultTo={defaultTo} />
      </Panel>

      <div style={{ height: 14 }} />
      <Panel title={`Experiments (${experiments.length})`} flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Market / Condition</th>
                <th>OOS Window</th>
                <th className="num">Selections</th>
                <th className="num">ROI</th>
                <th className="num">Brier</th>
                <th className="num">ECE</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {experiments.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted-box">
                    Bootstrap experiments are being created and run in the background — refresh shortly.
                  </td>
                </tr>
              )}
              {experiments.map((e) => {
                const cfg = JSON.parse(e.config_json);
                const m = e.metrics_json ? JSON.parse(e.metrics_json) : null;
                const cond = (cfg.matchFilters ?? [])
                  .map((f: { feature: string; op: string; value: number }) => `${f.feature} ${f.op === '>=' ? '≥' : f.op === '<=' ? '≤' : '∈'} ${f.value}`)
                  .join(', ');
                return (
                  <tr key={e.id}>
                    <td className="num strong">{e.code}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                      <div className="strong small">{e.title}</div>
                      <div className="micro faint" style={{ whiteSpace: 'normal' }}>
                        {e.hypothesis.slice(0, 120)}
                        {e.hypothesis.length > 120 ? '…' : ''}
                      </div>
                      {e.result_text && <div className="micro amber" style={{ whiteSpace: 'normal', marginTop: 4 }}>{e.result_text}</div>}
                    </td>
                    <td className="small dim">
                      {cfg.market}
                      {cfg.line ? ` ${cfg.line}` : ''}
                      {cond ? <div className="micro faint">{cond}</div> : null}
                    </td>
                    <td className="small faint">
                      {cfg.dataset?.testFrom?.slice(0, 10)} → {cfg.dataset?.testTo?.slice(0, 10)}
                    </td>
                    <td className="num">{m ? fmtInt(m.betting?.selections) : '—'}</td>
                    <td className={`num ${m?.betting?.roi > 0 ? 'pos' : m ? 'neg' : ''}`}>{m ? fmtPct(m.betting?.roi) : '—'}</td>
                    <td className="num">{m ? fmtNum(m.prediction?.brier, 4) : '—'}</td>
                    <td className="num">{m ? fmtPct(m.calibration?.ece, 1) : '—'}</td>
                    <td>
                      <span className={`badge st-${e.status}`}>{e.status}</span>
                    </td>
                    <td className="small faint">{fmtDateTime(e.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

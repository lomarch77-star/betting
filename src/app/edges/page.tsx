import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { listEdges, experimentById } from '@/lib/db/repos-research';
import { Panel, Notice } from '@/components/ui';
import { fmtPct, fmtNum, fmtInt, fmtDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function EdgesPage() {
  ensureBootstrapped();
  const db = getDb();
  const edges = listEdges(db);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Edge Registry</div>
          <div className="page-sub">
            Persistent, versioned hypotheses. Every registered edge points to a reproducible
            experiment with training / validation / out-of-sample evidence — nothing here is a
            "guaranteed value bet".
          </div>
        </div>
      </div>

      {edges.length === 0 && (
        <Notice kind="info">
          Bootstrap experiments are registering edges in the background — refresh once the default
          research jobs complete.
        </Notice>
      )}

      <div className="grid cols-2">
        {edges.map((e) => {
          const m = e.metrics_json ? JSON.parse(e.metrics_json) : null;
          const exp = e.experiment_id ? experimentById(db, e.experiment_id) : null;
          return (
            <Panel
              key={e.id}
              title={`${e.code} · ${e.title}`}
              right={<span className={`badge st-${e.status}`}>{e.status}</span>}
            >
              <div className="small dim" style={{ marginBottom: 8 }}>
                <span className="badge">{e.market_code}</span>{' '}
                {exp && <span className="badge info">linked exp {exp.code} · {exp.status}</span>}
              </div>
              <div className="small" style={{ color: 'var(--text-dim)', marginBottom: 10 }}>
                {e.hypothesis}
              </div>
              <table className="data">
                <tbody>
                  <tr><td>Training</td><td className="small num">{e.training_period ?? '—'}</td></tr>
                  <tr><td>Validation</td><td className="small num">{e.validation_period ?? '—'}</td></tr>
                  <tr><td>Out-of-sample</td><td className="small num">{e.oos_period ?? '—'}</td></tr>
                  <tr><td>Sample</td><td className="num">{fmtInt(e.sample_size)}</td></tr>
                  {m && (
                    <>
                      <tr><td>ROI (OOS sim)</td><td className={`num ${m.roi > 0 ? 'pos' : 'neg'}`}>{fmtPct(m.roi)}</td></tr>
                      <tr><td>Brier / LogLoss</td><td className="num">{fmtNum(m.brier, 4)} / {fmtNum(m.logLoss, 4)}</td></tr>
                      <tr><td>Max drawdown</td><td className="num neg">{fmtPct(m.maxDrawdownPct, 1)}</td></tr>
                      <tr><td>Calibration (ECE)</td><td className="num">{m.ece != null ? fmtPct(m.ece, 2) : '—'}</td></tr>
                      <tr>
                        <td>CLV diagnostics</td>
                        <td className="num">
                          {m.clv?.beatCloseRate != null ? `beat close ${fmtPct(m.clv.beatCloseRate, 0)}` : '—'}
                          {m.clv?.meanProbShift != null ? ` · shift ${(m.clv.meanProbShift * 100).toFixed(2)}pp` : ''}
                        </td>
                      </tr>
                    </>
                  )}
                  <tr><td>Registered</td><td className="small num faint">{fmtDate(e.created_at)}</td></tr>
                </tbody>
              </table>
            </Panel>
          );
        })}
      </div>

      <div style={{ height: 14 }} />
      <Panel title="Registry Discipline">
        <div className="mono-block">{`Statuses:  UNTESTED → PROMISING → VALIDATING → PASSED / REJECTED → RETIRED
Promotion requires: sufficient OOS sample AND calibration sanity AND
a human researcher approving the transition (audit-logged).
Nothing graduates on historical ROI alone.`}</div>
      </Panel>
    </>
  );
}

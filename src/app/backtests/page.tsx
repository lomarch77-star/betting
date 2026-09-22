import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { listBacktestRuns } from '@/lib/db/repos-research';
import { Panel } from '@/components/ui';
import { RunBacktestButton } from '@/components/run-button';
import { fmtPct, fmtNum, fmtInt, fmtDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BacktestsPage() {
  ensureBootstrapped();
  const runs = listBacktestRuns(getDb());
  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Backtests — Walk-Forward Validation</div>
          <div className="page-sub">
            Chronological, refit-per-round evaluation. Time-series data is NEVER shuffled into
            train/test splits; every price used existed before the simulated entry time.
          </div>
        </div>
        <RunBacktestButton />
      </div>

      <Panel title="Runs" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Status</th>
                <th className="num">Test Matches</th>
                <th className="num">Refits</th>
                <th className="num">Selections</th>
                <th className="num">ROI</th>
                <th className="num">Max DD</th>
                <th className="num">LogLoss</th>
                <th className="num">Brier</th>
                <th className="num">ECE</th>
                <th className="num">Beat Close</th>
                <th>Finished</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={14} className="muted-box">
                    The default walk-forward run starts automatically at bootstrap — it appears here while running and completes within a minute.
                  </td>
                </tr>
              )}
              {runs.map((r) => {
                const m = r.metrics_json ? JSON.parse(r.metrics_json) : null;
                return (
                  <tr key={r.id}>
                    <td className="num strong">{r.code}</td>
                    <td className="small dim">{r.name}</td>
                    <td>
                      <span className={`badge st-${r.status} ${r.status === 'RUNNING' ? 'pulsing' : ''}`}>{r.status}</span>
                      {r.error ? <div className="micro neg" style={{ maxWidth: 220 }}>{r.error}</div> : null}
                    </td>
                    <td className="num">{fmtInt(m?.testMatches)}</td>
                    <td className="num">{fmtInt(m?.refits)}</td>
                    <td className="num">{fmtInt(m?.betting?.selections)}</td>
                    <td className={`num ${m?.betting?.roi > 0 ? 'pos' : ''}`}>{fmtPct(m?.betting?.roi)}</td>
                    <td className="num neg">{m?.betting ? fmtPct(m.betting.maxDrawdownPct) : '—'}</td>
                    <td className="num">{fmtNum(m?.prediction?.logLoss, 4)}</td>
                    <td className="num">{fmtNum(m?.prediction?.brier, 4)}</td>
                    <td className="num">{fmtPct(m?.calibration?.ece, 1)}</td>
                    <td className="num">{m?.betting?.clv?.beatCloseRate != null ? fmtPct(m.betting.clv.beatCloseRate, 0) : '—'}</td>
                    <td className="small faint">{r.finished_at ? fmtDateTime(r.finished_at) : '—'}</td>
                    <td>
                      <Link className="btn small" href={`/backtests/${r.id}`}>
                        Detail →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div style={{ height: 14 }} />
      <Panel title="Protocol Guarantee">
        <div className="mono-block">{`1. Test matches consumed in strictly ascending kickoff order.
2. At each refit point T: models trained only on rows with kickoff < T
   (train/validation hold-out INSIDE the past; see models/pipeline.ts).
3. Predictions for [T, next refit) use only those models — no test result is
   ever visible to a model before its prediction.
4. Entry price = latest bookmaker snapshot at or before kickoff − 60 min.
   Closing prices are attached post-settlement for CLV diagnostics only.
5. No random shuffling anywhere. Identical DB + config ⇒ identical run.`}</div>
      </Panel>
    </>
  );
}

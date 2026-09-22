import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { backtestRunById, backtestSelections } from '@/lib/db/repos-research';
import { matchById, teamById, marketDefMap } from '@/lib/db/repos-core';
import { Panel, Kpi } from '@/components/ui';
import { BankrollChart, CalibrationCurve } from '@/components/charts';
import { RunProgressPoll } from '@/components/run-button';
import { fmtPct, fmtNum, fmtInt, fmtDate, fmtSignedPct } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BacktestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  const run = backtestRunById(db, Number(id));
  if (!run) notFound();
  const m = run.metrics_json ? JSON.parse(run.metrics_json) : null;
  const sels = backtestSelections(db, run.id);
  const defs = marketDefMap(db);

  const bankSeries: Array<{ at: string; value: number }> | null = m?.betting?.bankrollSeries ?? null;
  const homeBins: Array<{ count: number; meanPredicted: number; empirical: number }> | null =
    m?.calibration?.binsPerClass?.[0] ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-sub">
            <Link href="/backtests" className="accent">← Backtests</Link>
          </div>
          <div className="page-title">
            {run.code} — {run.name}
          </div>
          <div className="page-sub">
            fingerprint <span className="num">{m?.fingerprint ?? '—'}</span> · deterministic &amp;
            reproducible
          </div>
        </div>
        <span className={`badge st-${run.status} ${run.status === 'RUNNING' ? 'pulsing' : ''}`}>{run.status}</span>
      </div>

      <RunProgressPoll runId={run.id} status={run.status} />

      {run.status !== 'RUNNING' && m && (
        <>
          <div className="grid cols-6">
            <Kpi label="Test Matches" value={fmtInt(m.testMatches)} sub={`${m.refits} walk-forward refits`} />
            <Kpi label="Selections" value={fmtInt(m.betting.selections)} sub={`hit rate ${fmtPct(m.betting.hitRate, 0)}`} />
            <Kpi label="ROI / Yield" value={fmtPct(m.betting.roi)} sub={`staked ${fmtNum(m.betting.totalStaked, 0)} · P/L ${fmtSignedPct(m.betting.totalPnl / Math.max(1, m.betting.totalStaked))}`} tone={m.betting.roi > 0 ? 'good' : 'bad'} />
            <Kpi label="Max Drawdown" value={fmtPct(m.betting.maxDrawdownPct, 1)} sub={`longest losing streak ${m.betting.longestLosingStreak}`} tone="warn" />
            <Kpi label="LogLoss / Brier" value={fmtNum(m.prediction.logLoss, 3)} sub={`Brier ${fmtNum(m.prediction.brier, 4)} · acc ${fmtPct(m.prediction.accuracy, 1)}`} />
            <Kpi label="ECE" value={fmtPct(m.calibration.ece, 2)} sub={`beat-close ${m.betting.clv.beatCloseRate != null ? fmtPct(m.betting.clv.beatCloseRate, 0) : '—'} · CLV shift ${m.betting.clv.meanProbShift != null ? `${(m.betting.clv.meanProbShift * 100).toFixed(2)}pp` : '—'}`} />
          </div>

          <div style={{ height: 14 }} />
          <div className="grid cols-2">
            <Panel title="Bankroll Curve (Chronological Settlement)">
              {bankSeries ? <BankrollChart series={bankSeries} initial={m.betting ? 1000 : 1000} /> : <div className="muted-box">—</div>}
            </Panel>
            <Panel title="Calibration — Home Class (OOS)">
              {homeBins ? <CalibrationCurve bins={homeBins} labels={`ECE ${(m.calibration.ece * 100).toFixed(2)}%`} /> : <div className="muted-box">—</div>}
            </Panel>
          </div>

          <div style={{ height: 14 }} />
          <Panel title={`Selections Ledger (${sels.length})`} flush>
            <div className="table-wrap scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Kickoff</th>
                    <th>Fixture</th>
                    <th>Market</th>
                    <th>Sel</th>
                    <th className="num">Model P</th>
                    <th className="num">Fair</th>
                    <th className="num">Entry</th>
                    <th className="num">Close</th>
                    <th className="num">EV</th>
                    <th className="num">Stake</th>
                    <th className="num">Result</th>
                    <th className="num">P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {sels.map((s) => {
                    const fx = matchById(db, s.match_id);
                    const def = [...defs.values()].find((d) => d.id === s.market_id);
                    return (
                      <tr key={s.id}>
                        <td className="small dim">{fx ? fmtDate(fx.kickoff_utc) : s.settled_at.slice(0, 10)}</td>
                        <td className="small">
                          <Link href={`/matches/${s.match_id}`}>
                            {fx ? `${teamById(db, fx.home_team_id)?.short_name} v ${teamById(db, fx.away_team_id)?.short_name}` : `#${s.match_id}`}
                          </Link>
                        </td>
                        <td className="small faint">{def?.code}{def?.line != null ? ` ${def.line}` : ''}</td>
                        <td className="small strong">{s.selection}</td>
                        <td className="num">{fmtPct(s.model_probability)}</td>
                        <td className="num dim">{fmtNum(s.fair_odds)}</td>
                        <td className="num strong">{fmtNum(s.entry_odds)}</td>
                        <td className="num dim">{s.closing_odds != null ? fmtNum(s.closing_odds) : '—'}</td>
                        <td className="num pos">{fmtSignedPct(s.ev)}</td>
                        <td className="num">{fmtNum(s.stake)}</td>
                        <td>
                          <span className={`badge ${s.won ? 'ok' : 'bad'}`}>{s.won ? 'WON' : 'LOST'}</span>
                        </td>
                        <td className={`num ${s.pnl > 0 ? 'pos' : 'neg'}`}>{fmtNum(s.pnl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div style={{ height: 14 }} />
          <Panel title="Configuration (Reproducibility Record)">
            <div className="mono-block">{JSON.stringify(JSON.parse(run.config_json), null, 2)}</div>
          </Panel>
        </>
      )}
      {run.status === 'FAILED' && (
        <Panel title="Failure">
          <div className="notice warn">{run.error}</div>
        </Panel>
      )}
    </>
  );
}

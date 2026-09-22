import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { portfolioReport } from '@/lib/services/portfolioService';
import { matchById, teamById, marketDefMap } from '@/lib/db/repos-core';
import { Panel, Kpi, Notice } from '@/components/ui';
import { BankrollChart } from '@/components/charts';
import { fmtPct, fmtNum, fmtInt, fmtDateTime, fmtSignedPct } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  ensureBootstrapped();
  const db = getDb();
  const report = portfolioReport(db);
  const defs = marketDefMap(db);
  const m = report.metrics;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Paper Portfolio — Simulated Ledger</div>
          <div className="page-sub">
            Paper-tracking of model-vs-market observations. No real-money execution exists; entries
            record the model probability and price at entry time and settle from results.
          </div>
        </div>
        <span className="badge">SIMULATION ONLY</span>
      </div>

      <Notice kind="info">
        Entries are only accepted pre-kickoff, and claimed prices are validated against obtainable
        book prices at entry time — the ledger cannot be filled with post-hoc fantasy fills.
      </Notice>
      <div style={{ height: 14 }} />

      <div className="grid cols-6">
        <Kpi label="Bankroll" value={fmtNum(report.current, 1)} sub={`initial ${fmtNum(report.initial, 0)}`} />
        <Kpi label="Open Exposure" value={fmtNum(report.openExposure, 1)} sub={`${report.openCount} open entries`} />
        <Kpi label="ROI (settled)" value={fmtPct(m.roi)} sub={`${fmtInt(m.selections)} selections · hit ${fmtPct(m.hitRate, 0)}`} tone={m.roi > 0 ? 'good' : m.selections > 0 ? 'bad' : undefined} />
        <Kpi label="Max Drawdown" value={fmtPct(m.maxDrawdownPct, 1)} sub={`streak ${m.longestLosingStreak} losses`} />
        <Kpi label="Avg Entry Odds" value={fmtNum(m.avgOdds)} sub={`staked ${fmtNum(m.totalStaked, 1)}`} />
        <Kpi
          label="CLV Diagnostic"
          value={m.clv.beatCloseRate != null ? fmtPct(m.clv.beatCloseRate, 0) : '—'}
          sub={m.clv.meanProbShift != null ? `implied shift ${(m.clv.meanProbShift * 100).toFixed(2)}pp vs close` : 'settle entries for CLV'}
        />
      </div>

      <div style={{ height: 14 }} />
      <Panel title="Bankroll Curve">
        {m.bankrollSeries.length > 1 ? (
          <BankrollChart series={m.bankrollSeries} initial={report.initial} />
        ) : (
          <div className="muted-box">Add entries from any scheduled match research view, then wait for settlement.</div>
        )}
      </Panel>

      <div style={{ height: 14 }} />
      <Panel title={`Ledger (${report.entries.length})`} flush>
        <div className="table-wrap scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Entered</th>
                <th>Fixture</th>
                <th>Market / Sel</th>
                <th className="num">Entry Odds</th>
                <th className="num">Model P</th>
                <th className="num">Stake</th>
                <th className="num">Closing</th>
                <th>Result</th>
                <th className="num">P/L</th>
              </tr>
            </thead>
            <tbody>
              {report.entries.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted-box">
                    Ledger empty. Log simulated entries from a match research page ("+ Paper ledger").
                  </td>
                </tr>
              )}
              {report.entries.map((e) => {
                const fx = matchById(db, e.match_id);
                const def = [...defs.values()].find((d) => d.id === e.market_id);
                return (
                  <tr key={e.id}>
                    <td className="small dim">{fmtDateTime(e.entered_at)}</td>
                    <td className="small">
                      <Link href={`/matches/${e.match_id}`}>
                        {fx ? `${teamById(db, fx.home_team_id)?.short_name} v ${teamById(db, fx.away_team_id)?.short_name}` : `#${e.match_id}`}
                      </Link>
                    </td>
                    <td className="small dim">
                      {def?.code}
                      {def?.line != null ? ` ${def.line}` : ''} · <span className="strong">{e.selection}</span>
                    </td>
                    <td className="num strong">{fmtNum(e.odds_at_entry)}</td>
                    <td className="num dim">{fmtPct(e.model_probability)}</td>
                    <td className="num">{fmtNum(e.stake)}</td>
                    <td className="num dim">{e.closing_odds != null ? fmtNum(e.closing_odds) : '—'}</td>
                    <td>
                      {e.result ? (
                        <span className={`badge ${e.result === 'WON' ? 'ok' : 'bad'}`}>{e.result}</span>
                      ) : (
                        <span className="badge info">OPEN</span>
                      )}
                    </td>
                    <td className={`num ${e.pnl != null && e.pnl > 0 ? 'pos' : 'neg'}`}>
                      {e.pnl != null ? fmtSignedPct(e.pnl / Math.max(0.01, e.stake)) : '—'}
                    </td>
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

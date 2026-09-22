import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { dashboardSummary } from '@/lib/services/dashboardService';
import { Panel, Kpi, Notice } from '@/components/ui';
import { CalibrationCurve } from '@/components/charts';
import { fmtPct, fmtNum, fmtInt, fmtDateTime, fmtDate } from '@/lib/format';
import type { ReactElement } from 'react';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  ensureBootstrapped();
  const s = await dashboardSummary(getDb());
  const bt = s.modelHealth.latestBacktest;
  const calib = bt?.metrics?.calibration;
  const homeBins: Array<{ count: number; meanPredicted: number; empirical: number }> | null =
    calib?.binsPerClass?.[0] ?? null;

  const w = s.modelHealth.ensemble.weights as unknown as Record<string, number>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Terminal Dashboard</div>
          <div className="page-sub">
            Quantitative match-market research overview · {s.today.date} · deterministic demo
            universe (clearly labelled)
          </div>
        </div>
        <span className="badge demo">DEMO DATASET — SYNTHETIC UNIVERSE v1</span>
      </div>

      <div className="grid cols-6">
        <Kpi label="Matches Analysed" value={fmtInt(s.today.matchesAnalyzed)} sub="persisted model predictions" />
        <Kpi label="Upcoming · 7d" value={fmtInt(s.today.matchesUpcoming7d)} sub="scheduled fixtures" />
        <Kpi label="Model Versions" value={fmtInt(s.today.modelsRunning)} sub="immutable registry entries" />
        <Kpi label="Markets Tracked" value={fmtInt(s.today.marketsTracked)} sub="market definitions" />
        <Kpi label="Odds Snapshots" value={fmtInt(s.today.oddsSnapshots)} sub="timestamped observations" />
        <Kpi
          label="Active Experiments"
          value={fmtInt(s.today.activeExperiments)}
          sub={`${s.today.totalExperiments} total in lab`}
        />
      </div>

      <div style={{ height: 14 }} />
      <Panel title="Model Health — Live Ensemble" right={<span className="badge ok">CALIBRATED</span>}>
        <div className="grid cols-4">
          <div>
            <div className="micro faint" style={{ marginBottom: 8 }}>
              ENSEMBLE WEIGHTS (VALIDATION-DERIVED)
            </div>
            {(Object.entries(w) as Array<[string, number]>).map(([k, v]) => (
              <div key={k} className="prob-row" style={{ gridTemplateColumns: '82px 1fr 48px' }}>
                <span className="dim small">{k}</span>
                <div className="prob-bar">
                  <div className="prob-fill" style={{ width: `${v * 100}%` }} />
                </div>
                <span className="num" style={{ textAlign: 'right' }}>
                  {(v * 100).toFixed(0)}%
                </span>
              </div>
            ))}
            <div className="micro faint" style={{ marginTop: 10 }}>
              Trained on {fmtInt(s.modelHealth.ensemble.trainedOn)} matches · fitted{' '}
              {fmtDateTime(s.modelHealth.ensemble.fittedAt)}
            </div>
          </div>
          <div>
            <div className="micro faint" style={{ marginBottom: 8 }}>
              HOLD-OUT VALIDATION (150d)
            </div>
            <table className="data">
              <tbody>
                <tr>
                  <td>Log loss (calibrated)</td>
                  <td className="num strong">{fmtNum(s.modelHealth.ensemble.validation.ensembleLogLoss, 4)}</td>
                </tr>
                <tr>
                  <td>Brier score</td>
                  <td className="num strong">{fmtNum(s.modelHealth.ensemble.validation.ensembleBrier, 4)}</td>
                </tr>
                <tr>
                  <td>Validation rows</td>
                  <td className="num">{fmtInt(s.modelHealth.ensemble.validation.rows)}</td>
                </tr>
              </tbody>
            </table>
            <div className="micro faint" style={{ marginTop: 8 }}>
              prediction accuracy is NOT probability calibration — both are reported separately
            </div>
          </div>
          <div>
            <div className="micro faint" style={{ marginBottom: 8 }}>
              LATEST OOS BACKTEST {bt ? `· ${bt.code}` : ''}
            </div>
            {bt?.metrics ? (
              <table className="data">
                <tbody>
                  <tr>
                    <td>Test matches</td>
                    <td className="num">{fmtInt(bt.metrics.testMatches)}</td>
                  </tr>
                  <tr>
                    <td>Log loss</td>
                    <td className="num">{fmtNum(bt.metrics.prediction?.logLoss, 4)}</td>
                  </tr>
                  <tr>
                    <td>Brier</td>
                    <td className="num">{fmtNum(bt.metrics.prediction?.brier, 4)}</td>
                  </tr>
                  <tr>
                    <td>ECE</td>
                    <td className="num">{fmtPct(bt.metrics.calibration?.ece, 2)}</td>
                  </tr>
                  <tr>
                    <td>Selections / ROI</td>
                    <td className="num">
                      {fmtInt(bt.metrics.betting?.selections)} /{' '}
                      <span className={bt.metrics.betting?.roi > 0 ? 'pos' : 'neg'}>
                        {fmtPct(bt.metrics.betting?.roi)}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <Notice kind="info">
                Default walk-forward backtest is queued/running in the background — refreshes
                automatically when complete.
              </Notice>
            )}
          </div>
          <div>
            <div className="micro faint" style={{ marginBottom: 8 }}>
              CALIBRATION (HOME CLASS, OOS)
            </div>
            {homeBins ? (
              <CalibrationCurve bins={homeBins} labels={bt?.code} />
            ) : (
              <div className="muted-box">Calibration curve appears after the first backtest.</div>
            )}
          </div>
        </div>
      </Panel>

      <div className="grid cols-3">
        <Panel title="Data Quality" right={<span className="badge ok">ENGINE ACTIVE</span>}>
          {s.modelHealth.dataQuality ? (
            <table className="data">
              <tbody>
                <tr><td>Last run</td><td className="num">{fmtDateTime(s.modelHealth.dataQuality.runAt)}</td></tr>
                <tr><td>Valid records</td><td className="num pos">{fmtInt(s.modelHealth.dataQuality.valid)}</td></tr>
                <tr><td>Warnings</td><td className="num amber">{fmtInt(s.modelHealth.dataQuality.warnings)}</td></tr>
                <tr><td>Invalid (quarantined)</td><td className="num neg">{fmtInt(s.modelHealth.dataQuality.invalid)}</td></tr>
              </tbody>
            </table>
          ) : (
            <div className="muted-box">DQ engine not run yet.</div>
          )}
        </Panel>

        <Panel title="Data Freshness">
          <table className="data">
            <tbody>
              <tr><td>Latest finished match</td><td className="num">{fmtDateTime(s.today.dataFreshness.latestFinishedKickoff)}</td></tr>
              <tr><td>Latest odds snapshot</td><td className="num">{fmtDateTime(s.today.dataFreshness.latestOddsSnapshot)}</td></tr>
              <tr><td>Validation status</td><td className="num">{s.today.validationStatus ? `${s.today.validationStatus.code} · ${fmtDate(s.today.validationStatus.finishedAt)}` : 'running'}</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Paper Portfolio (Simulated)" right={<span className="badge">NO REAL MONEY</span>}>
          <table className="data">
            <tbody>
              <tr><td>Bankroll</td><td className="num strong">{fmtNum(s.today.paperPortfolio.current, 1)} <span className="faint">/ {fmtNum(s.today.paperPortfolio.initial, 0)}</span></td></tr>
              <tr><td>ROI (settled)</td><td className={`num ${s.today.paperPortfolio.roi > 0 ? 'pos' : ''}`}>{fmtPct(s.today.paperPortfolio.roi)}</td></tr>
              <tr><td>Open entries</td><td className="num">{s.today.paperPortfolio.openEntries}</td></tr>
              <tr><td>Settled selections</td><td className="num">{s.today.paperPortfolio.settledSelections}</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>

      <PipelinePanel />
    </>
  );
}

function PipelinePanel(): ReactElement {
  const arch = ` DATA INGESTION → NORMALIZATION → FEATURE ENGINE (leakage-safe, streaming)
        │                ┌──────────────┬──────────────┐
        ▼                ▼              ▼              ▼
  TEAM MODEL       GOAL MODEL      LOGISTIC      GRADIENT BOOST
  (Elo ratings)    (Poisson λ)     (softmax)      (residual trees)
        │                └──────────────┴──────────────┘
        ▼                                ▼
  ENSEMBLE (validation weights) → CALIBRATION (isotonic) → FAIR-ODDS ENGINE
        ▼
  MARKET COMPARATOR → OPPORTUNITY ANALYSIS → BACKTEST / VALIDATION → ANALYST UI`;
  return (
    <div style={{ marginTop: 14 }}>
      <Panel title="Processing Architecture">
        <div className="arch-block">{arch}</div>
      </Panel>
    </div>
  );
}

import { getDb } from '@/lib/db/client';
import { ensureBootstrapped } from '@/lib/bootstrap';
import { listModelVersions, countPredictions } from '@/lib/db/repos-research';
import { standardEnsemble } from '@/lib/services/predictionService';
import { Panel, Kpi } from '@/components/ui';
import { fmtDateTime, fmtInt, fmtNum } from '@/lib/format';

export const dynamic = 'force-dynamic';

const MODEL_DOCS: Record<string, string> = {
  ELO: 'Chronologically updated ratings; 3-way via grid-fitted draw model. Feature: pre-match rating gap.',
  POISSON: 'Attack/defence strengths by weighted MLE (time-decayed). Score matrix → all goal markets.',
  LOGISTIC: 'Multinomial softmax regression over 17 leakage-safe streaming features, L2-regularised.',
  GBM: 'Multinomial gradient boosting on residual trees (depth 3, deterministic quantile splits).',
  ENSEMBLE: 'Validation-weighted arithmetic combination + isotonic calibration. Configuration stored per prediction.',
};

export default async function ModelsPage() {
  ensureBootstrapped();
  const db = getDb();
  const versions = listModelVersions(db);
  const std = await standardEnsemble(db);
  const val = std.fitted.validation;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Model Registry</div>
          <div className="page-sub">
            Every configuration is an immutable version row — a changed config is a new version,
            never an overwrite. All four base models must produce P(home)+P(draw)+P(away)=1; the
            invariant is enforced in the test suite.
          </div>
        </div>
      </div>

      <div className="grid cols-4">
        <Kpi label="Registry Versions" value={fmtInt(versions.length)} sub="insert-only audit trail" />
        <Kpi
          label="Live Weights: ELO / POISSON"
          value={`${((std.fitted.weights.ELO + std.fitted.weights.POISSON) * 100).toFixed(0)}%`}
          sub={`ELO ${(std.fitted.weights.ELO * 100).toFixed(0)} · POI ${(std.fitted.weights.POISSON * 100).toFixed(0)} · LOG ${(std.fitted.weights.LOGISTIC * 100).toFixed(0)} · GBM ${(std.fitted.weights.GBM * 100).toFixed(0)}`}
        />
        <Kpi label="Validation LogLoss" value={fmtNum(val.ensembleLogLoss, 4)} sub={`Brier ${fmtNum(val.ensembleBrier, 4)} · ${fmtInt(val.rows)} rows`} />
        <Kpi label="Live Train Sample" value={fmtInt(std.fitted.trainedOn)} sub={`fitted ${fmtDateTime(std.asOf)}`} />
      </div>

      <div style={{ height: 14 }} />

      <Panel title="Component Model Validation (Current Hold-Out Window)">
        <table className="data">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Log loss</th>
              <th className="num">Brier</th>
              <th>Methodology</th>
            </tr>
          </thead>
          <tbody>
            {(['ELO', 'POISSON', 'LOGISTIC', 'GBM'] as const).map((k) => {
              const m = val.perModel[k];
              return (
                <tr key={k}>
                  <td className="strong">{k}</td>
                  <td className="num">{fmtNum(m?.logLoss ?? null, 4)}</td>
                  <td className="num">{fmtNum(m?.brier ?? null, 4)}</td>
                  <td className="small dim">{MODEL_DOCS[k]}</td>
                </tr>
              );
            })}
            <tr>
              <td className="strong accent">ENSEMBLE (calibrated)</td>
              <td className="num strong">{fmtNum(val.ensembleLogLoss, 4)}</td>
              <td className="num strong">{fmtNum(val.ensembleBrier, 4)}</td>
              <td className="small dim">{MODEL_DOCS.ENSEMBLE}</td>
            </tr>
          </tbody>
        </table>
        <div className="micro faint" style={{ marginTop: 8 }}>
          Metrics computed on the current 150-day hold-out before the live fit point. Historical
          OOS performance across seasons lives under Backtests.
        </div>
      </Panel>

      <div style={{ height: 14 }} />

      <Panel title="Version Registry (Immutable)" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Kind</th>
                <th>Name</th>
                <th className="num">Train Sample</th>
                <th>Window</th>
                <th>Fingerprint</th>
                <th className="num">Predictions</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="num strong">{v.code}</td>
                  <td><span className="badge info">{v.kind}</span></td>
                  <td className="small dim">{v.name}</td>
                  <td className="num">{fmtInt(v.train_sample)}</td>
                  <td className="small faint">
                    {v.train_window_from?.slice(0, 10)} → {v.train_window_to?.slice(0, 10)}
                  </td>
                  <td className="num faint">{v.dataset_fingerprint ?? '—'}</td>
                  <td className="num">{fmtInt(countPredictions(db, v.id))}</td>
                  <td className="small faint">{fmtDateTime(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

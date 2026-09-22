/**
 * Research repositories: model versions, predictions, feature snapshots,
 * experiments, backtest runs/selections, edge registry, paper portfolio,
 * data-quality reports, audit log, settings.
 *
 * Immutability discipline (spec §4/§35):
 *   - model_versions: insert-only
 *   - model_predictions: insert-only (ON CONFLICT DO NOTHING — first
 *     prediction for a (match, version) pair is the audit record)
 */

import type { Db } from './client';
import { nowIso } from './client';
import type { ExperimentStatus, ModelKind, EdgeStatus } from '@/lib/types';

// ─── Model versions & predictions ────────────────────────────────────────────

export interface ModelVersionRow {
  id: number;
  code: string;
  kind: ModelKind;
  name: string;
  config_json: string;
  train_window_from: string | null;
  train_window_to: string | null;
  train_sample: number | null;
  dataset_fingerprint: string | null;
  created_at: string;
}

export function insertModelVersion(
  db: Db,
  v: Omit<ModelVersionRow, 'id' | 'created_at'>,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO model_versions
         (code, kind, name, config_json, train_window_from, train_window_to, train_sample, dataset_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.code,
        v.kind,
        v.name,
        v.config_json,
        v.train_window_from,
        v.train_window_to,
        v.train_sample,
        v.dataset_fingerprint,
        nowIso(),
      ).lastInsertRowid,
  );
}

export function modelVersionByCode(db: Db, code: string): ModelVersionRow | undefined {
  return db.prepare('SELECT * FROM model_versions WHERE code = ?').get(code) as
    | ModelVersionRow
    | undefined;
}

export function modelVersionById(db: Db, id: number): ModelVersionRow | undefined {
  return db.prepare('SELECT * FROM model_versions WHERE id = ?').get(id) as
    | ModelVersionRow
    | undefined;
}

export function listModelVersions(db: Db): ModelVersionRow[] {
  return db
    .prepare('SELECT * FROM model_versions ORDER BY created_at DESC, id DESC')
    .all() as unknown as ModelVersionRow[];
}

export interface PredictionInsert {
  match_id: number;
  model_version_id: number;
  market_id: number;
  selection: string;
  probability: number;
  fair_odds: number;
  predicted_at: string;
  as_of: string;
  detail_json?: string;
}

/** Insert-only. Existing prediction for (match, version, market, selection) is kept. */
export function insertPredictions(db: Db, rows: PredictionInsert[]): number {
  const stmt = db.prepare(
    `INSERT INTO model_predictions
     (match_id, model_version_id, market_id, selection, probability, fair_odds, predicted_at, as_of, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, model_version_id, market_id, selection) DO NOTHING`,
  );
  let n = 0;
  for (const r of rows) {
    n += Number(
      stmt.run(
        r.match_id,
        r.model_version_id,
        r.market_id,
        r.selection,
        r.probability,
        r.fair_odds,
        r.predicted_at,
        r.as_of,
        r.detail_json ?? null,
      ).changes,
    );
  }
  return n;
}

export interface PredictionRow extends PredictionInsert {
  id: number;
}

export function predictionsForMatch(db: Db, matchId: number): PredictionRow[] {
  return db
    .prepare('SELECT * FROM model_predictions WHERE match_id = ? ORDER BY model_version_id, market_id, selection')
    .all(matchId) as unknown as PredictionRow[];
}

export function predictionsForVersion(
  db: Db,
  versionId: number,
  marketCode?: string,
): PredictionRow[] {
  if (marketCode) {
    return db
      .prepare(
        `SELECT p.* FROM model_predictions p JOIN market_defs m ON m.id = p.market_id
         WHERE p.model_version_id = ? AND m.code = ? ORDER BY p.as_of`,
      )
      .all(versionId, marketCode) as unknown as PredictionRow[];
  }
  return db
    .prepare('SELECT * FROM model_predictions WHERE model_version_id = ? ORDER BY as_of')
    .all(versionId) as unknown as PredictionRow[];
}

export function countPredictions(db: Db, versionId?: number): number {
  const r = (
    versionId
      ? db.prepare('SELECT COUNT(*) AS c FROM model_predictions WHERE model_version_id = ?').get(versionId)
      : db.prepare('SELECT COUNT(*) AS c FROM model_predictions').get()
  ) as { c: number };
  return r.c;
}

export function insertFeatureSnapshot(
  db: Db,
  matchId: number,
  asOf: string,
  featureJson: string,
): void {
  db.prepare(
    `INSERT INTO feature_snapshots (match_id, as_of, feature_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (match_id, as_of) DO NOTHING`,
  ).run(matchId, asOf, featureJson, nowIso());
}

// ─── Experiments ─────────────────────────────────────────────────────────────

export interface ExperimentRow {
  id: number;
  code: string;
  title: string;
  hypothesis: string;
  config_json: string;
  status: ExperimentStatus;
  metrics_json: string | null;
  result_text: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function nextCode(db: Db, table: string, prefix: string): string {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return `${prefix}-${String(r.c + 1).padStart(4, '0')}`;
}

export function insertExperiment(
  db: Db,
  e: { title: string; hypothesis: string; config_json: string; created_by?: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO experiments (code, title, hypothesis, config_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nextCode(db, 'experiments', 'EXP'),
        e.title,
        e.hypothesis,
        e.config_json,
        e.created_by ?? 'system',
        nowIso(),
        nowIso(),
      ).lastInsertRowid,
  );
}

export function updateExperimentResult(
  db: Db,
  id: number,
  status: ExperimentStatus,
  metricsJson: string,
  resultText: string,
): void {
  db.prepare(
    'UPDATE experiments SET status = ?, metrics_json = ?, result_text = ?, updated_at = ? WHERE id = ?',
  ).run(status, metricsJson, resultText, nowIso(), id);
}

export function setExperimentStatus(db: Db, id: number, status: ExperimentStatus): void {
  db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    id,
  );
}

export function experimentById(db: Db, id: number): ExperimentRow | undefined {
  return db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as
    | ExperimentRow
    | undefined;
}

export function listExperiments(db: Db): ExperimentRow[] {
  return db.prepare('SELECT * FROM experiments ORDER BY id DESC').all() as unknown as ExperimentRow[];
}

// ─── Backtests ───────────────────────────────────────────────────────────────

export interface BacktestRunRow {
  id: number;
  code: string;
  name: string;
  config_json: string;
  model_version_id: number | null;
  status: string;
  metrics_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function insertBacktestRun(
  db: Db,
  b: { name: string; config_json: string; model_version_id?: number | null },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO backtest_runs (code, name, config_json, model_version_id, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(nextCode(db, 'backtest_runs', 'BT'), b.name, b.config_json, b.model_version_id ?? null, nowIso())
      .lastInsertRowid,
  );
}

export function finishBacktestRun(
  db: Db,
  id: number,
  status: 'COMPLETE' | 'FAILED',
  metricsJson: string | null,
  error: string | null,
): void {
  db.prepare(
    'UPDATE backtest_runs SET status = ?, metrics_json = ?, error = ?, finished_at = ? WHERE id = ?',
  ).run(status, metricsJson, error, nowIso(), id);
}

export function backtestRunById(db: Db, id: number): BacktestRunRow | undefined {
  return db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id) as
    | BacktestRunRow
    | undefined;
}

export function listBacktestRuns(db: Db): BacktestRunRow[] {
  return db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC').all() as unknown as BacktestRunRow[];
}

export interface BacktestSelectionInsert {
  run_id: number;
  match_id: number;
  market_id: number;
  selection: string;
  model_probability: number;
  fair_odds: number;
  entry_odds: number;
  closing_odds?: number | null;
  bookmaker?: string | null;
  ev: number;
  stake: number;
  won: boolean;
  pnl: number;
  settled_at: string;
  as_of: string;
  predicted_probs_json?: string;
}

export function insertBacktestSelections(db: Db, rows: BacktestSelectionInsert[]): void {
  const stmt = db.prepare(
    `INSERT INTO backtest_selections
     (run_id, match_id, market_id, selection, model_probability, fair_odds, entry_odds,
      closing_odds, bookmaker, ev, stake, won, pnl, settled_at, as_of, predicted_probs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.run_id,
      r.match_id,
      r.market_id,
      r.selection,
      r.model_probability,
      r.fair_odds,
      r.entry_odds,
      r.closing_odds ?? null,
      r.bookmaker ?? null,
      r.ev,
      r.stake,
      r.won ? 1 : 0,
      r.pnl,
      r.settled_at,
      r.as_of,
      r.predicted_probs_json ?? null,
    );
  }
}

export type BacktestSelectionRow = Omit<BacktestSelectionInsert, 'won'> & {
  id: number;
  won: number; // 0/1 in storage
};

export function backtestSelections(db: Db, runId: number): BacktestSelectionRow[] {
  return db
    .prepare('SELECT * FROM backtest_selections WHERE run_id = ? ORDER BY settled_at, id')
    .all(runId) as unknown as BacktestSelectionRow[];
}

// ─── Edge registry ───────────────────────────────────────────────────────────

export interface EdgeRow {
  id: number;
  code: string;
  title: string;
  market_code: string;
  hypothesis: string;
  experiment_id: number | null;
  training_period: string | null;
  validation_period: string | null;
  oos_period: string | null;
  sample_size: number | null;
  metrics_json: string | null;
  status: EdgeStatus;
  created_at: string;
  updated_at: string;
}

export function insertEdge(
  db: Db,
  e: {
    title: string;
    market_code: string;
    hypothesis: string;
    experiment_id?: number | null;
    training_period?: string | null;
    validation_period?: string | null;
    oos_period?: string | null;
    sample_size?: number | null;
    metrics_json?: string | null;
    status?: EdgeStatus;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO edges
         (code, title, market_code, hypothesis, experiment_id, training_period, validation_period,
          oos_period, sample_size, metrics_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nextCode(db, 'edges', 'EDGE'),
        e.title,
        e.market_code,
        e.hypothesis,
        e.experiment_id ?? null,
        e.training_period ?? null,
        e.validation_period ?? null,
        e.oos_period ?? null,
        e.sample_size ?? null,
        e.metrics_json ?? null,
        e.status ?? 'UNTESTED',
        nowIso(),
        nowIso(),
      ).lastInsertRowid,
  );
}

export function updateEdge(
  db: Db,
  id: number,
  patch: {
    status?: EdgeStatus;
    metrics_json?: string;
    sample_size?: number;
    experiment_id?: number | null;
  },
): void {
  const current = db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
  if (!current) throw new Error(`updateEdge: no edge ${id}`);
  db.prepare(
    `UPDATE edges SET status = ?, metrics_json = ?, sample_size = ?, experiment_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.metrics_json ?? current.metrics_json,
    patch.sample_size ?? current.sample_size,
    patch.experiment_id === undefined ? current.experiment_id : patch.experiment_id,
    nowIso(),
    id,
  );
}

export function edgeById(db: Db, id: number): EdgeRow | undefined {
  return db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
}

export function listEdges(db: Db): EdgeRow[] {
  return db.prepare('SELECT * FROM edges ORDER BY id').all() as unknown as EdgeRow[];
}

// ─── Paper portfolio ─────────────────────────────────────────────────────────

export interface PaperEntryRow {
  id: number;
  match_id: number;
  market_id: number;
  selection: string;
  bookmaker: string;
  odds_at_entry: number;
  model_probability: number;
  model_version_id: number | null;
  stake: number;
  entered_at: string;
  closing_odds: number | null;
  result: string | null;
  pnl: number | null;
  settled_at: string | null;
  notes: string | null;
}

export function insertPaperEntry(
  db: Db,
  e: Omit<PaperEntryRow, 'id' | 'closing_odds' | 'result' | 'pnl' | 'settled_at'>,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO paper_entries
         (match_id, market_id, selection, bookmaker, odds_at_entry, model_probability,
          model_version_id, stake, entered_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.match_id,
        e.market_id,
        e.selection,
        e.bookmaker,
        e.odds_at_entry,
        e.model_probability,
        e.model_version_id,
        e.stake,
        e.entered_at,
        e.notes ?? null,
      ).lastInsertRowid,
  );
}

export function settlePaperEntry(
  db: Db,
  id: number,
  result: string,
  pnl: number,
  closingOdds: number | null,
): void {
  db.prepare(
    'UPDATE paper_entries SET result = ?, pnl = ?, closing_odds = ?, settled_at = ? WHERE id = ?',
  ).run(result, pnl, closingOdds, nowIso(), id);
}

export function listPaperEntries(db: Db): PaperEntryRow[] {
  return db.prepare('SELECT * FROM paper_entries ORDER BY entered_at, id').all() as unknown as PaperEntryRow[];
}

export function unsettledPaperEntries(db: Db): PaperEntryRow[] {
  return db
    .prepare("SELECT * FROM paper_entries WHERE result IS NULL ORDER BY entered_at")
    .all() as unknown as PaperEntryRow[];
}

// ─── Data quality ────────────────────────────────────────────────────────────

export function insertDqReport(
  db: Db,
  scope: string,
  counts: { valid: number; warning: number; invalid: number },
  summaryJson: string,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO data_quality_reports (run_at, scope, valid_count, warning_count, invalid_count, summary_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nowIso(), scope, counts.valid, counts.warning, counts.invalid, summaryJson).lastInsertRowid,
  );
}

export function insertDqIssue(
  db: Db,
  reportId: number,
  issue: {
    severity: string;
    entity: string;
    entity_id: string;
    rule_code: string;
    message: string;
    detail_json?: string;
  },
): void {
  db.prepare(
    `INSERT INTO data_quality_issues (report_id, severity, entity, entity_id, rule_code, message, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reportId,
    issue.severity,
    issue.entity,
    issue.entity_id,
    issue.rule_code,
    issue.message,
    issue.detail_json ?? null,
  );
}

export function latestDqReport(db: Db): {
  id: number;
  run_at: string;
  scope: string;
  valid_count: number;
  warning_count: number;
  invalid_count: number;
  summary_json: string;
} | null {
  return (
    (db
      .prepare('SELECT * FROM data_quality_reports ORDER BY id DESC LIMIT 1')
      .get() as
      | {
          id: number;
          run_at: string;
          scope: string;
          valid_count: number;
          warning_count: number;
          invalid_count: number;
          summary_json: string;
        }
      | undefined) ?? null
  );
}

export function dqIssuesForReport(
  db: Db,
  reportId: number,
): Array<{
  id: number;
  severity: string;
  entity: string;
  entity_id: string;
  rule_code: string;
  message: string;
  detail_json: string | null;
}> {
  return db
    .prepare('SELECT * FROM data_quality_issues WHERE report_id = ? ORDER BY severity DESC, id')
    .all(reportId) as unknown as Array<{
    id: number;
    severity: string;
    entity: string;
    entity_id: string;
    rule_code: string;
    message: string;
    detail_json: string | null;
  }>;
}

// ─── Audit log ───────────────────────────────────────────────────────────────

export function audit(
  db: Db,
  entry: {
    actor: string;
    role: string;
    action: string;
    entity: string;
    entity_id?: string | number | null;
    detail?: unknown;
  },
): void {
  db.prepare(
    'INSERT INTO audit_log (at, actor, role, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    nowIso(),
    entry.actor,
    entry.role,
    entry.action,
    entry.entity,
    entry.entity_id == null ? null : String(entry.entity_id),
    entry.detail == null ? null : JSON.stringify(entry.detail),
  );
}

export function listAudit(db: Db, limit = 200): Array<{
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  entity: string;
  entity_id: string | null;
  detail_json: string | null;
}> {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as Array<{
    id: number;
    at: string;
    actor: string;
    role: string;
    action: string;
    entity: string;
    entity_id: string | null;
    detail_json: string | null;
  }>;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export function getSetting(db: Db, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, nowIso());
}

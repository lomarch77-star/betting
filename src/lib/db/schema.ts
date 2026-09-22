/**
 * Database schema — single source of truth for DDL.
 *
 * Written in portable SQL (ISO-8601 TEXT timestamps, JSON-in-TEXT) so the
 * schema maps 1:1 onto PostgreSQL. The migration path to PG is a dialect
 * shuffle (AUTOINCREMENT→GENERATED, CHECK types) contained in this file;
 * no application code changes required thanks to the repository layer.
 */

export const SCHEMA_VERSION = '1';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  region TEXT NOT NULL DEFAULT 'DEMO'
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  code TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'FINISHED',
  UNIQUE (competition_id, code)
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL UNIQUE,
  short_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS team_seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  final_position INTEGER,
  points INTEGER, played INTEGER, won INTEGER, drawn INTEGER, lost INTEGER,
  goals_for INTEGER, goals_against INTEGER,
  UNIQUE (team_id, season_id)
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  team_id INTEGER REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  round INTEGER NOT NULL,
  kickoff_utc TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  venue_id INTEGER REFERENCES venues(id),
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  home_goals INTEGER, away_goals INTEGER,
  home_xg REAL, away_xg REAL,
  home_shots INTEGER, away_shots INTEGER,
  home_shots_on INTEGER, away_shots_on INTEGER,
  home_corners INTEGER, away_corners INTEGER,
  possession_home REAL,
  data_source TEXT NOT NULL DEFAULT 'demo-generator-v1',
  is_demo INTEGER NOT NULL DEFAULT 1,
  quality_status TEXT NOT NULL DEFAULT 'VALID',
  ingestion_id TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (competition_id, season_id, round, home_team_id, away_team_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches (kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_matches_season ON matches (season_id, round);
CREATE INDEX IF NOT EXISTS idx_matches_status_kickoff ON matches (status, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_matches_home ON matches (home_team_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_matches_away ON matches (away_team_id, kickoff_utc);

CREATE TABLE IF NOT EXISTS bookmakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  margin_profile REAL NOT NULL DEFAULT 0.04,
  is_demo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS market_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  line REAL,
  name TEXT NOT NULL,
  UNIQUE (code, line)
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  bookmaker_id INTEGER NOT NULL REFERENCES bookmakers(id),
  market_id INTEGER NOT NULL REFERENCES market_defs(id),
  selection TEXT NOT NULL,
  decimal_odds REAL NOT NULL CHECK (decimal_odds >= 1.001 AND decimal_odds <= 1001),
  taken_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1,
  UNIQUE (match_id, bookmaker_id, market_id, selection, taken_at)
);
CREATE INDEX IF NOT EXISTS idx_odds_match ON odds_snapshots (match_id, market_id, selection, taken_at);
CREATE INDEX IF NOT EXISTS idx_odds_taken ON odds_snapshots (taken_at);

CREATE TABLE IF NOT EXISTS model_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  train_window_from TEXT,
  train_window_to TEXT,
  train_sample INTEGER,
  dataset_fingerprint TEXT,
  created_at TEXT NOT NULL
);
-- NOTE: model_versions is immutable by convention — no UPDATE statements
-- exist for it anywhere in the codebase; a new config is a new version row.

CREATE TABLE IF NOT EXISTS model_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
  market_id INTEGER NOT NULL REFERENCES market_defs(id),
  selection TEXT NOT NULL,
  probability REAL NOT NULL CHECK (probability > 0 AND probability < 1),
  fair_odds REAL NOT NULL,
  predicted_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  detail_json TEXT,
  UNIQUE (match_id, model_version_id, market_id, selection)
);
CREATE INDEX IF NOT EXISTS idx_pred_match ON model_predictions (match_id, model_version_id);
CREATE INDEX IF NOT EXISTS idx_pred_model ON model_predictions (model_version_id, predicted_at);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  as_of TEXT NOT NULL,
  feature_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (match_id, as_of)
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNTESTED',
  metrics_json TEXT,
  result_text TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  model_version_id INTEGER REFERENCES model_versions(id),
  status TEXT NOT NULL DEFAULT 'RUNNING',
  metrics_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS backtest_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  market_id INTEGER NOT NULL REFERENCES market_defs(id),
  selection TEXT NOT NULL,
  model_probability REAL NOT NULL,
  fair_odds REAL NOT NULL,
  entry_odds REAL NOT NULL,
  closing_odds REAL,
  bookmaker TEXT,
  ev REAL NOT NULL,
  stake REAL NOT NULL,
  won INTEGER,
  pnl REAL,
  settled_at TEXT,
  as_of TEXT NOT NULL,
  predicted_probs_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_sel ON backtest_selections (run_id, settled_at);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  market_code TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  experiment_id INTEGER REFERENCES experiments(id),
  training_period TEXT,
  validation_period TEXT,
  oos_period TEXT,
  sample_size INTEGER,
  metrics_json TEXT,
  status TEXT NOT NULL DEFAULT 'UNTESTED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  market_id INTEGER NOT NULL REFERENCES market_defs(id),
  selection TEXT NOT NULL,
  bookmaker TEXT NOT NULL,
  odds_at_entry REAL NOT NULL,
  model_probability REAL NOT NULL,
  model_version_id INTEGER REFERENCES model_versions(id),
  stake REAL NOT NULL,
  entered_at TEXT NOT NULL,
  closing_odds REAL,
  result TEXT,
  pnl REAL,
  settled_at TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_entered ON paper_entries (entered_at);

CREATE TABLE IF NOT EXISTS data_quality_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  valid_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES data_quality_reports(id),
  severity TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_dq_report ON data_quality_issues (report_id, severity);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

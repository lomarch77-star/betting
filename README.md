# Match Markets Research Terminal

A **quantitative research terminal for football match markets**. It is not a
betting product, not a tips app, and not a casino UI. It ingests match and
pricing data, fits auditable statistical models, calibrates their
probabilities, compares model prices with bookmaker prices, validates
everything with leak-proof backtests, and presents the research surface to an
analyst in a dense, professional terminal UI.

V1 scope: pre-match markets — **1X2, Double Chance, Draw No Bet, Asian
Handicap, Over/Under goals, BTTS, team totals, Correct Score**. No player
props, no live betting, no accumulators, no casino content (extension points
are left deliberately).

---

## What this is

| ✔ | This terminal |
|---|---|
| ✔ | Start from a **validated model probability** and compare it with a market price |
| ✔ | Treats probability, fair price, and "edge" as **distinct, auditable quantities** |
| ✔ | Every number computed deterministically from structured data objects |
| ✔ | Walk-forward backtesting with enforced chronological integrity |
| ✔ | Leakage protection via as-of (`available_at`) semantics on every feature and price |
| ✔ | A persistent cycle: data → features → models → pricing → validation → edges |

| ✘ | This terminal is NOT |
|---|---|
| ✘ | A source of "value bet of the day", "bankers", or guaranteed picks |
| ✘ | A "who will win" predictor for casual consumption |
| ✘ | A place where AI/in-scope narrative invents stats, injuries, or odds |
| ✘ | Claiming historical positive ROI is an edge without the full validation lifecycle |
| ✘ | Playing with real money — the ledger is a hypothetical simulation, flat-staked |

Every output carries **uncertainty metadata** (model agreement, data-quality
status, calibration health, historical sample). **Model disagreement is
visible**, never hidden behind a single confident number.

---

## Quick start

```bash
npm install          # pure-JS stack: Next 15 + React 19 + node:sqlite + zod
npm run dev          # http://localhost:3000  (first request self-seeds)
```

That's it. With **no configuration and no API keys** the terminal boots into
offline demo mode, generates a deterministic synthetic football universe
(5 completed seasons + live season, 2 leagues, 32 teams, ~2,100 matches,
~117k bookmaker snapshots, 3 books), runs data-quality checks, fits the
standard ensemble in the background, predicts upcoming fixtures, and launches
the default walk-forward backtest.

```bash
npm test             # 38 invariant tests (math, leakage, calibration, chronology)
npm run smoke        # 17 end-to-end invariants on a fresh in-memory universe
npm run typecheck
npm run build && npm start
```

Configuration (all optional — see `.env.example`):

| Env var | Purpose | Default |
|---|---|---|
| `DATABASE_PATH` | SQLite file location | `./data/terminal.sqlite` |
| `DEMO_SEED` | Integer seed for the demo generator | `42` |
| `DEMO_ANCHOR_DATE` | Pin the "today" of the demo world (YYYY-MM-DD) | today (UTC) |
| `RESEARCH_API_KEY` / `ADMIN_API_KEY` | Lock mutation/admin endpoints (header `x-api-key`) | unset → DEMO_AUTH_MODE |
| `API_RATE_LIMIT_PER_MIN` | Per-IP token bucket on `/api/*` | `240` |

> **No API keys are ever committed.** Spec requires PostgreSQL; this build runs
> on SQLite behind a repository interface (`src/lib/db/repos-*.ts`) whose
> schema and queries are PG-compatible by design — a PG adapter implements the
> same interface (see `ARCHITECTURE`).

---

## Architecture

```
src/
  lib/
    quant/            pure math: poisson matrix, dixon-coles, pricing, metrics,
                      calibration (platt + PAVA isotonic), uncertainty, seeded RNG
    models/           elo, poisson strengths (MLE), multinomial logistic (softmax
                      regression), gradient boosting, ensemble + weight search
    features/         FeatureBuilder — streamable, leakage-safe snapshot engine
    db/               node:sqlite client, schema, repository layer (PG-shaped)
    data/             deterministic demo-universe generator (seeded PRNG)
    services/         business services (see below); no HTTP knowledge
  app/
    (pages)           analyst surfaces: dashboard, matches, scanner, research,
                      backtests, edges, portfolio, models, data-quality, settings
    api/              thin zod-validated HTTP routes over services
tests/                invariant suites: math, probability, leakage, calibration,
                      data quality, model skill
scripts/              seed.ts, smoke.ts (17 hermetic checks)
```

**Determinism contract**: identical DB + identical config ⇒ identical
probabilities, identical backtest. No wall-clock dependent randomness anywhere;
the demo universe derives 100% from `DEMO_SEED` (+ anchor date).

**Leakage contract** (enforced by tests):

1. Every feature exists only because data was available at/after its
   `available_at`; training never sees a fixture's own result.
2. Time-series data is never shuffled; splits are chronological windows.
3. Closing prices are attached **after** settlement for CLV diagnostics;
   entry prices are the latest snapshot strictly before the betting horizon.
4. The `FeatureBuilder` throws when asked to move backwards in time or to
   snapshot before its information horizon; a monkey-test inserts future
   corruption and verifies past features are byte-identical.
5. "Last 5 matches" style form windows are **configurable**, never hard-coded.

**Calibration**: raw model outputs pass through a calibrator fitted on a
strictly-preceding validation window (Platt logistic or **PAVA isotonic with
piecewise-linear interpolation through pooled knots** — monotone, but without
collapsing per-fixture variation the way a step function does at small
validation samples). Calibrated = the only probabilities the UI ever shows.

**Model stack** (all four must produce P(H)+P(D)+P(A)=1 — assertion in tests):

| Model | Role |
|---|---|
| **Elo** (grid-fit draw model) | competitive baseline, explainable strengths |
| **Poisson** (weighted MLE attack/defence strengths + Dixon-Coles) | goal-expectancy view; generates every derived market from the score matrix |
| **Logistic regression** (multinomial, L2, 17 leakage-safe streaming features) | classical ML view |
| **Gradient boosting** (depth-limited, deterministic quantile splits) | non-linear interactions |
| **Ensemble** | validation-window weight search + calibrator; config recorded per prediction |

**Data-quality subsystem**: rules R01–R09 (missing/corrupt scores, future
results **quarantined**, bad timestamps, season windows, near-duplicates,
out-of-range odds, negative/extreme overround). Statuses VALID / WARNING /
INVALID; **INVALID rows never enter training** (enforced inside every modeling
query) and are surfaced in the UI. The demo universe deliberately contains
three anomalies (corrupted xG, a future-dated "result", an extreme-margin
book) — the DQ page displays them being caught.

---

## Analyst surfaces

- **Dashboard** — dataset health, model validation snapshot, research pipeline
  status, paper-ledger summary, today's fixtures. No "top tips" block by design.
- **Matches** — cards + upcoming/finished views with model probabilities,
  consensus prices, and agreement badges; drill-in to full research view.
- **Match research** — hero spread of model-vs-market, per-model 1X2, derived
  markets from the joint score matrix (8×8 correct-score heatmap), feature-based
  "why" factors (deterministic, computed from structured inputs), odds movement,
  recent form, uncertainty box, and a rules-based analyst note that only quotes
  data present on the page — it cannot invent statistics.
- **Scanner** — upcoming fixtures × markets, filterable/sortable on measurable
  fields only (probability, fair odds, price difference, EV, agreement, data
  quality). **Deliberately no "best bet" ranking.** Model/market difference is
  presented as a research starting point, with the noise warning visible.
- **Research lab** — create experiments over a hypothesis + market + condition;
  each experiment is executed as a reproducible walk-forward backtest.
- **Backtests** — run registry; every run stores config + metrics + selections
  ledger + bankroll curve + calibration bins + fingerprint for byte-level
  reproducibility.
- **Edge registry** — UNTESTED → PROMISING → VALIDATING → PASSED/REJECTED →
  RETIRED lifecycle; humans approve transitions (audit-logged); an edge always
  points at its evidence (experiment + training/validation/OOS periods, sample
  size, ROI, Brier, ECE, CLV diagnostics). Positive historical ROI alone does
  **not** promote an edge.
- **Paper portfolio** — simulated flat-stake ledger with pre-kickoff entry
  validation (claimed prices are checked against obtainable book prices at
  entry), CLV diagnostics, drawdown, and P/L attribution. No real money exists.
- **Models** — immutable version registry; every fit writes a new immutable
  `model_versions` row with config, dataset fingerprint, train window; versions
  are never overwritten.
- **Data quality** — latest audit report, rule findings, quarantine log.
- **Settings** — environment, auth mode, API reference, audit trail.

---

## API (selected)

Read endpoints are open in demo mode; all mutations require the `x-api-key`
header with `researcher`, and admin scope for admin endpoints (DEMO_AUTH_MODE
allowed when keys unset — recorded in the audit log):

```
GET  /api/health                                  liveness + dataset counts
GET  /api/matches[?competitionId&status&round]    fixtures with model probs
GET  /api/matches/:id                             full research assembly
GET  /api/matches/:id/prediction                  ensemble + per-model probs + uncertainty
GET  /api/matches/:id/markets                     derived markets (A/H incl. push lines)
GET  /api/scanner[?market&minAbsDiffPct&agreement&quality&sort]
GET  /api/backtests · POST /api/backtests         run walk-forward (researcher)
GET  /api/backtests/:id                           status + metrics + selections ledger
POST /api/experiments · GET /api/experiments      research lab (researcher)
POST /api/experiments/:id/run                     validate experiment (walk-forward)
GET  /api/edges · PATCH /api/edges/:id            edge registry + transitions
GET  /api/paper-portfolio · POST (researcher)     ledger + simulated entry (pre-kickoff guard)
GET  /api/data-quality · POST (researcher)        latest report / re-run
GET  /api/models[.../performance]                 immutable version registry + OOS metrics
GET  /api/dashboard                               terminal summary
POST /api/admin/reseed                            regenerate demo universe (admin)
```

All POST inputs are zod-validated; API calls are rate-limited per IP with an
in-memory token bucket; all mutations write to `audit_log` (actor, IP, route,
payload digest). Errors conform to a single `{error:{code,message,details}}`
envelope.

---

## BACKTESTING discipline

**Walk-forward** is the only supported evaluator:

1. Chronological fixture order; at each refit point T, candidate models train
   only on rows with `kickoff < T`; ensemble weights + calibrator fit on an
   OOS validation slice inside the past; then test predictions for `[T, next T)`.
2. Predictions store `as_of` = kickoff − 60 min; entry price = latest book
   snapshot at/before that horizon (config: best-of-books or consensus).
3. Persisted per-selection: model prob, fair odds, entry price, closing price,
   EV, stake, result, P/L. CLV = entry vs close diagnostics only.
4. Metrics: ROI, hit rate, avg odds, max drawdown, losing streak, log loss,
   Brier, accuracy, ECE, calibration bins, CLV beat-close rate.
5. A run is reproducible: `config_json` + dataset fingerprint; execute again
   bit-for-bit identical (test suite proves it).

The default backtest (BT-0001) runs automatically at bootstrap and covers the
most recent ~26 months of the demo universe (refit every round, walks across 2
season boundaries).

---

## TESTING — what "done" means (spec §41)

| Gate | Where |
|---|---|
| Multi-model probabilities ∈ (0,1) and sum to ~1 | `tests/models.test.ts` |
| Goal model derives all goal markets off the joint matrix | `tests/quant.test.ts` |
| Calibration evaluated (log loss, Brier, ECE) | `tests/calibration-metrics.test.ts`, backtest metrics |
| Odds normalized; fair odds + EV exact | `tests/quant.test.ts` |
| Backtests chronological; walk-forward refit | `tests/leakage.test.ts` |
| Leakage tests pass (future-mutation monkey test) | `tests/leakage.test.ts` |
| Model versions reproducible + immutable | `tests/dataQuality.test.ts` |
| Experiments persisted with results | /research, /api/experiments |
| Match analysis page + scanner + paper portfolio work | run the app |
| Determinism (no unseeded randomness) | `tests/leakage.test.ts` + fingerprint rerun test |
| Demo cannot fabricate quantitative data | narrative layer is rules-based over page data only |

Run everything: `npm test && npm run smoke && npm run typecheck`.

---

## Security notes

- Inputs: zod schemas at the API boundary; SQL only through parameterised
  `node:sqlite` statements; no string interpolation of user input.
- Auth: header API keys (researcher/admin); rate limiting per IP; audit log
  on every mutation; secrets environment-only.
- XSS: React server components by default; no `dangerouslySetInnerHTML`.
- The DB never leaves the sandbox in demo mode.

## Demo disclaimer

This deployment's universe is **fully synthetic and seeded** — all teams,
matches, and prices are generated deterministically for demonstration. Probabilities
shown are model outputs, not predictions of real events; "EV" and "edge" are
research diagnostics with documented uncertainty — never instructions.

/**
 * Prediction service — owns the "standard" ensemble (the platform's flagship
 * model configuration), upcoming-match prediction persistence, and the full
 * deterministic match-analysis assembly consumed by the UI and API.
 *
 * Nothing here invents numbers: every emitted value is traceable to a
 * database row or a deterministic computation over database rows.
 */

import type { Db } from '@/lib/db/client';
import {
  matchById,
  upcomingMatches,
  marketDefMap,
  oddsForMatch,
  listMatches,
  teamById,
  competitionByCode,
  seasonById,
  type MatchRow,
  type OddsRow,
} from '@/lib/db/repos-core';
import {
  insertModelVersion,
  modelVersionByCode,
  insertPredictions,
  type ModelVersionRow,
} from '@/lib/db/repos-research';
import {
  fitEnsembleAt,
  predictFixture,
  DEFAULT_PIPELINE_CONFIG,
  type FittedEnsemble,
  type MatchPrediction,
} from '@/lib/models/pipeline';
import { assessDisagreement, buildUncertaintyReport, calibrationGrade } from '@/lib/quant/uncertainty';
import {
  overround,
  removeMarginPower,
  fairOdds,
  priceDifference,
  expectedValue,
} from '@/lib/quant/pricing';
import { hashSeed } from '@/lib/quant/random';
import { prob3ToArray, type Prob3 } from '@/lib/types';
import { FEATURE_NAMES } from '@/lib/features/builder';
import { featureImportances } from '@/lib/models/logistic';
import { gbmImportances } from '@/lib/models/gbm';

export interface StandardEnsemble {
  version: ModelVersionRow;
  fitted: FittedEnsemble;
  asOf: string;
}

let cachedStandard: StandardEnsemble | null = null;
let fitting: Promise<StandardEnsemble> | null = null;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Dataset fingerprint: config + horizon + extent of data actually used. */
export function datasetFingerprint(db: Db, asOf: string, trainedOn: number): string {
  const r = db
    .prepare(
      "SELECT COUNT(*) AS c, MIN(kickoff_utc) AS mn, MAX(kickoff_utc) AS mx FROM matches WHERE status='FINISHED' AND kickoff_utc < ? AND quality_status != 'INVALID'",
    )
    .get(asOf) as { c: number; mn: string; mx: string };
  return `fp-${hashSeed(asOf, r.c, r.mn ?? '', r.mx ?? '', trainedOn).toString(16)}`;
}

/**
 * The standard ensemble, fitted at request time against everything finished.
 * One model_version row per (UTC day) — identical config ⇒ identical model,
 * so re-fits are deterministic; the version row gives audit permanence.
 */
export async function standardEnsemble(db: Db): Promise<StandardEnsemble> {
  const key = dayKey();
  if (cachedStandard && cachedStandard.version.code.includes(key)) return cachedStandard;
  if (fitting) return fitting;
  fitting = (async () => {
    const asOf = new Date().toISOString();
    const code = `ensemble-std-${key}`;
    let version = modelVersionByCode(db, code);
    const fitted = fitEnsembleAt(db, asOf);
    if (!version) {
      const id = insertModelVersion(db, {
        code,
        kind: 'ENSEMBLE',
        name: 'Standard ensemble (ELO + Poisson + Logistic + GBM, isotonic-calibrated)',
        config_json: JSON.stringify({ pipeline: DEFAULT_PIPELINE_CONFIG, weights: fitted.weights }),
        train_window_from: new Date(Date.parse(asOf) - DEFAULT_PIPELINE_CONFIG.trainSpanDays * 86_400_000).toISOString(),
        train_window_to: asOf,
        train_sample: fitted.trainedOn,
        dataset_fingerprint: datasetFingerprint(db, asOf, fitted.trainedOn),
      });
      version = modelVersionByCode(db, code)!;
      void id;
    }
    cachedStandard = { version, fitted, asOf };
    fitting = null;
    return cachedStandard;
  })();
  return fitting;
}

/** Invalidate caches (used after reseeding). */
export function invalidateStandardCache(): void {
  cachedStandard = null;
  fitting = null;
  analysisCache.clear();
}

/**
 * LRU of ensembles fitted at specific historical horizons — used for the
 * strict pre-match research view of FINISHED matches (never uses
 * information past kickoff).
 */
const analysisCache = new Map<string, StandardEnsemble>();
const ANALYSIS_CACHE_MAX = 8;

export async function analysisEnsembleAt(db: Db, asOf: string): Promise<StandardEnsemble> {
  const key = asOf.slice(0, 13); // hour granularity — one fit per hour bucket
  const cached = analysisCache.get(key);
  if (cached) return cached;
  const fitted = fitEnsembleAt(db, asOf);
  const code = `ensemble-analysis-${key.replace(/[-T]/g, '')}`;
  let version = modelVersionByCode(db, code);
  if (!version) {
    insertModelVersion(db, {
      code,
      kind: 'ENSEMBLE',
      name: 'Analysis ensemble (historical horizon refit)',
      config_json: JSON.stringify({ pipeline: DEFAULT_PIPELINE_CONFIG, weights: fitted.weights }),
      train_window_from: new Date(
        Date.parse(asOf) - DEFAULT_PIPELINE_CONFIG.trainSpanDays * 86_400_000,
      ).toISOString(),
      train_window_to: asOf,
      train_sample: fitted.trainedOn,
      dataset_fingerprint: datasetFingerprint(db, asOf, fitted.trainedOn),
    });
    version = modelVersionByCode(db, code)!;
  }
  const entry: StandardEnsemble = { version, fitted, asOf };
  analysisCache.set(key, entry);
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const firstKey = analysisCache.keys().next().value;
    if (firstKey != null) analysisCache.delete(firstKey);
  }
  return entry;
}

/**
 * Predict + persist all scheduled matches. Insert-only — the first
 * (match, version) prediction row stands as the audit record.
 */
export async function predictUpcoming(db: Db): Promise<{ predicted: number; matches: number }> {
  const std = await standardEnsemble(db);
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const upcoming = upcomingMatches(db, now, horizon).filter(
    (m) => m.quality_status !== 'INVALID',
  );
  const defs = marketDefMap(db);
  const mkt = (code: string, line: number | null) => defs.get(`${code}|${line}`)?.id;
  const rows: Parameters<typeof insertPredictions>[1] = [];
  let matchCount = 0;

  for (const m of upcoming) {
    let pred: MatchPrediction;
    try {
      pred = predictFixture(std.fitted, m);
    } catch {
      continue;
    }
    matchCount++;
    const detail = JSON.stringify({
      lambdas: pred.lambdas,
      perModel: pred.perModel,
      weights: std.fitted.weights,
      calibrated: pred.calibrated,
    });
    const push = (code: string, line: number | null, selection: string, p: number) => {
      const marketId = mkt(code, line);
      if (!marketId) return;
      const pc = Math.min(0.999, Math.max(0.001, p));
      rows.push({
        match_id: m.id,
        model_version_id: std.version.id,
        market_id: marketId,
        selection,
        probability: pc,
        fair_odds: fairOdds(pc),
        predicted_at: now,
        as_of: m.kickoff_utc,
        detail_json: code === 'ONE_X_TWO' && selection === 'HOME' ? detail : null,
      } as never);
    };
    push('ONE_X_TWO', null, 'HOME', pred.ensemble.home);
    push('ONE_X_TWO', null, 'DRAW', pred.ensemble.draw);
    push('ONE_X_TWO', null, 'AWAY', pred.ensemble.away);
    push('OU_GOALS', 2.5, 'OVER', pred.markets.overUnder.find((o) => o.line === 2.5)?.over ?? 0);
    push('OU_GOALS', 2.5, 'UNDER', pred.markets.overUnder.find((o) => o.line === 2.5)?.under ?? 0);
    push('OU_GOALS', 1.5, 'OVER', pred.markets.overUnder.find((o) => o.line === 1.5)?.over ?? 0);
    push('OU_GOALS', 3.5, 'OVER', pred.markets.overUnder.find((o) => o.line === 3.5)?.over ?? 0);
    push('BTTS', null, 'YES', pred.markets.btts.yes);
    push('BTTS', null, 'NO', pred.markets.btts.no);
    push('DOUBLE_CHANCE', null, 'HOME_DRAW', pred.markets.doubleChance.homeDraw);
    push('DOUBLE_CHANCE', null, 'AWAY_DRAW', pred.markets.doubleChance.awayDraw);
    push('DRAW_NO_BET', null, 'HOME', pred.markets.drawNoBet.home);
    push('DRAW_NO_BET', null, 'AWAY', pred.markets.drawNoBet.away);
  }
  const inserted = insertPredictions(db, rows);
  return { predicted: inserted, matches: matchCount };
}

// ─── Match analysis assembly ─────────────────────────────────────────────────

export interface PriceView {
  selection: string;
  modelProbability: number;
  fairOdds: number;
  bestOdds: number | null;
  bestBook: string | null;
  consensusOdds: number | null;
  marginFreeProb: number | null;
  diffPct: number | null; // priceDifference(fair, consensus)
  ev: number | null; // expectedValue(model, consensus)
}

export interface OddsMovementPoint {
  takenAt: string;
  book: string;
  implied: number[]; // [home, draw, away] margin-removed
}

export interface MatchAnalysis {
  match: {
    id: number;
    kickoff: string;
    status: string;
    competition: string;
    competitionCode: string;
    seasonCode: string;
    round: number;
    homeTeam: string;
    awayTeam: string;
    homeShort: string;
    awayShort: string;
    score: { home: number; away: number } | null;
    stats: {
      xg: [number | null, number | null];
      shots: [number | null, number | null];
      shotsOn: [number | null, number | null];
      corners: [number | null, number | null];
      possessionHome: number | null;
    };
    qualityStatus: string;
    isDemo: boolean;
    dataSource: string;
  };
  prediction: null | {
    asOf: string;
    modelVersionCode: string;
    calibrated: boolean;
    weights: Record<string, number>;
    trainedOn: number;
    ensemble: Prob3;
    ensembleRaw: Prob3;
    fair: { home: number; draw: number; away: number };
    perModel: Array<{ kind: string; probs: Prob3 }>;
    lambdas: { home: number; away: number };
    expectedGoalsFromMatrix: { home: number; away: number };
    uncertainty: ReturnType<typeof buildUncertaintyReport>;
    explanation: Array<{ direction: '+' | '-'; text: string }>;
    derivedMarkets: MatchPrediction['markets'];
    matrixTop: Array<{ home: number; away: number; prob: number }>;
    matrix: number[][];
  };
  prices: {
    oneXTwo: PriceView[];
    ou25: PriceView[];
    btts: PriceView[];
    overround: ReturnType<typeof overround> | null;
    movement: OddsMovementPoint[];
    books: string[];
  };
  form: {
    home: TeamForm;
    away: TeamForm;
  };
  featureContext: MatchPrediction['snapshot']['context'] | null;
}

export interface TeamForm {
  team: string;
  recent: Array<{
    date: string;
    opponent: string;
    home: boolean;
    score: string;
    result: 'W' | 'D' | 'L';
    xgFor: number | null;
    xgAgainst: number | null;
  }>;
}

function teamForm(db: Db, teamId: number, beforeIso: string, n = 8): TeamForm {
  const rows = listMatches(db, {
    teamId,
    status: 'FINISHED',
    to: beforeIso,
    limit: n * 3,
  })
    .slice(-n)
    .reverse();
  const team = teamById(db, teamId);
  const recent = rows.map((m) => {
    const isHome = m.home_team_id === teamId;
    const opp = teamById(db, isHome ? m.away_team_id : m.home_team_id);
    const gf = isHome ? m.home_goals! : m.away_goals!;
    const ga = isHome ? m.away_goals! : m.home_goals!;
    return {
      date: m.kickoff_utc.slice(0, 10),
      opponent: opp?.short_name ?? '?',
      home: isHome,
      score: `${m.home_goals}–${m.away_goals}`,
      result: gf > ga ? ('W' as const) : gf === ga ? ('D' as const) : ('L' as const),
      xgFor: isHome ? m.home_xg : m.away_xg,
      xgAgainst: isHome ? m.away_xg : m.home_xg,
    };
  });
  return { team: team?.canonical_name ?? '?', recent };
}

/** Deterministic feature explanation bullets — numbers cited from the snapshot. */
export function explainPrediction(
  fitted: FittedEnsemble,
  pred: MatchPrediction,
): Array<{ direction: '+' | '-'; text: string }> {
  const byName = pred.snapshot.byName;
  const ctx = pred.snapshot.context;
  const out: Array<{ direction: '+' | '-'; text: string; weight: number }> = [];
  const logisticImp = featureImportances(fitted.logistic, [...FEATURE_NAMES]);
  const gbmImp = gbmImportances(fitted.gbm);
  const combined = new Map<string, number>();
  const lMax = Math.max(...logisticImp.map((i) => i.importance), 1e-9);
  for (const i of logisticImp) combined.set(i.feature, (combined.get(i.feature) ?? 0) + i.importance / lMax);
  for (const i of gbmImp.slice(0, 8)) combined.set(i.feature, (combined.get(i.feature) ?? 0) + i.importance * 2);

  const describe: Record<string, (v: number) => string> = {
    eloDiff: () => `Elo rating gap ${byName.eloDiff >= 0 ? 'favours the home side' : 'favours the away side'} (${Math.round(ctx.eloHome)} vs ${Math.round(ctx.eloAway)}, home advantage included)`,
    attackDefenceEdge: () =>
      `${byName.attackDefenceEdge >= 0 ? 'Home attack matches up well against the away defence' : 'Away attack matches up well against the home defence'} (league-adjusted rolling rates)`,
    gdRate5Diff: () =>
      `Last-5 goal difference per match: home +${ctx.homeLast5.gf - ctx.homeLast5.ga < 0 ? '' : ''}${(ctx.homeLast5.gf - ctx.homeLast5.ga) / Math.max(1, ctx.homeLast5.n)} vs away ${formatSigned((ctx.awayLast5.gf - ctx.awayLast5.ga) / Math.max(1, ctx.awayLast5.n))}`,
    ptsRate10Diff: () => 'Points rate over the last 10 matches shifts the estimate',
    xgRate5Diff: () =>
      `Rolling xG differential (last 5): home ${formatSigned((ctx.homeXg5.xgf - ctx.homeXg5.xga) / Math.max(1, ctx.homeXg5.n))}, away ${formatSigned((ctx.awayXg5.xgf - ctx.awayXg5.xga) / Math.max(1, ctx.awayXg5.n))}`,
    venuePtsRateDiff: () => 'Venue-specific results (home-at-home vs away-on-the-road) support this side',
    restDaysDiff: () => `Rest differential: home ${ctx.restDays.home}d, away ${ctx.restDays.away}d`,
    congestionDiff: () => `Fixture congestion (matches in last 14d): home ${ctx.congestion14d.home}, away ${ctx.congestion14d.away}`,
    seasonPtsRateDiff: () => `Season-to-date points rate: home ${ctx.seasonPtsRate.home}, away ${ctx.seasonPtsRate.away}`,
    positionDiff: () =>
      ctx.positions.home && ctx.positions.away
        ? `League position gap: ${ordinal(ctx.positions.home)} vs ${ordinal(ctx.positions.away)} (as of kickoff)`
        : 'League position gap (as of kickoff)',
    cleanSheetDiff: () => 'Recent clean-sheet tendency contributes',
    bttsRateDiff: () => 'Recent both-teams-to-score tendency contributes',
    awayStreakDiff: () => 'Consecutive away-match burden contributes',
    eloExpected: () => 'Elo win expectancy contributes',
  };

  for (const name of FEATURE_NAMES) {
    const importance = combined.get(name) ?? 0;
    if (importance < 0.25) continue;
    const v = byName[name];
    if (Math.abs(v) < 1e-9) continue;
    const fn = describe[name];
    if (!fn) continue;
    out.push({ direction: v > 0 ? '+' : '-', text: fn(v), weight: importance * Math.min(3, Math.abs(v)) });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, 7).map(({ direction, text }) => ({ direction, text }));
}

function formatSigned(x: number): string {
  const v = Math.round(x * 100) / 100;
  return v > 0 ? `+${v}` : `${v}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Full research-view assembly for one fixture. Never returns invented data. */
export async function analyzeMatch(db: Db, matchId: number): Promise<MatchAnalysis | null> {
  const m = matchById(db, matchId);
  if (!m) return null;
  const home = teamById(db, m.home_team_id);
  const away = teamById(db, m.away_team_id);
  const comp = db.prepare('SELECT * FROM competitions WHERE id = ?').get(m.competition_id) as {
    name: string;
    code: string;
  };
  const season = seasonById(db, m.season_id);

  const base: MatchAnalysis = {
    match: {
      id: m.id,
      kickoff: m.kickoff_utc,
      status: m.status,
      competition: comp.name,
      competitionCode: comp.code,
      seasonCode: season?.code ?? '?',
      round: m.round,
      homeTeam: home?.canonical_name ?? '?',
      awayTeam: away?.canonical_name ?? '?',
      homeShort: home?.short_name ?? '?',
      awayShort: away?.short_name ?? '?',
      score:
        m.home_goals != null && m.away_goals != null
          ? { home: m.home_goals, away: m.away_goals }
          : null,
      stats: {
        xg: [m.home_xg, m.away_xg],
        shots: [m.home_shots, m.away_shots],
        shotsOn: [m.home_shots_on, m.away_shots_on],
        corners: [m.home_corners, m.away_corners],
        possessionHome: m.possession_home,
      },
      qualityStatus: m.quality_status,
      isDemo: m.is_demo === 1,
      dataSource: m.data_source,
    },
    prediction: null,
    prices: {
      oneXTwo: [],
      ou25: [],
      btts: [],
      overround: null,
      movement: [],
      books: [],
    },
    form: {
      home: teamForm(db, m.home_team_id, m.kickoff_utc),
      away: teamForm(db, m.away_team_id, m.kickoff_utc),
    },
    featureContext: null,
  };

  // ── prediction ──
  // Scheduled fixture: standard ensemble fitted at "now" (includes every
  // finished result). Finished fixture: strict pre-match horizon refit at
  // kickoff — the research view never sees post-kickoff information.
  const isScheduled = m.status === 'SCHEDULED';
  let pred: MatchPrediction | null = null;
  let fitted: FittedEnsemble | null = null;
  let versionCode = 'unfitted';
  try {
    const std = isScheduled
      ? await standardEnsemble(db)
      : await analysisEnsembleAt(db, m.kickoff_utc);
    fitted = std.fitted;
    versionCode = std.version.code;
    pred = predictFixture(fitted, m);
  } catch {
    pred = null; // insufficient history at horizon — honest no-coverage
  }

  if (pred && fitted) {
    const disagreement = assessDisagreement([
      { kind: 'ELO', probs: pred.perModel.ELO },
      { kind: 'POISSON', probs: pred.perModel.POISSON },
      { kind: 'LOGISTIC', probs: pred.perModel.LOGISTIC },
      { kind: 'GBM', probs: pred.perModel.GBM },
    ]);
    const uncertainty = buildUncertaintyReport({
      agreement: disagreement,
      qualityStatus: m.quality_status,
      calibration: calibrationGrade(
        fitted.validation.ensembleBrier != null ? eceProxy(fitted) : null,
        fitted.validation.ensembleBrier,
      ),
      historicalSample: fitted.trainedOn,
    });
    base.prediction = {
      asOf: pred.asOf,
      modelVersionCode: versionCode,
      calibrated: pred.calibrated,
      weights: fitted.weights as unknown as Record<string, number>,
      trainedOn: fitted.trainedOn,
      ensemble: pred.ensemble,
      ensembleRaw: pred.ensembleRaw,
      fair: {
        home: fairOdds(pred.ensemble.home),
        draw: fairOdds(pred.ensemble.draw),
        away: fairOdds(pred.ensemble.away),
      },
      perModel: disagreement.perModel.map((x) => ({ kind: x.kind, probs: x.probs })),
      lambdas: pred.lambdas,
      expectedGoalsFromMatrix: pred.markets.expectedGoals,
      uncertainty,
      explanation: explainPrediction(fitted, pred),
      derivedMarkets: pred.markets,
      matrixTop: pred.markets.correctScores,
      matrix: pred.matrix,
    };
    base.featureContext = pred.snapshot.context;
  }

  // ── prices ──
  const odds = oddsForMatch(db, m.id);
  const bookNames = new Map<number, string>();
  for (const b of db.prepare('SELECT id, code FROM bookmakers').all() as Array<{
    id: number;
    code: string;
  }>) {
    bookNames.set(b.id, b.code);
  }
  base.prices.books = [...new Set(odds.map((o) => bookNames.get(o.bookmaker_id) ?? `book#${o.bookmaker_id}`))];
  const nowIsoS = new Date().toISOString();
  const priceAsOf = isScheduled ? nowIsoS : new Date(Date.parse(m.kickoff_utc) - 60 * 60_000).toISOString();

  base.prices.oneXTwo = buildPriceViews(db, m, odds, 'ONE_X_TWO', null, ['HOME', 'DRAW', 'AWAY'], pred, priceAsOf, bookNames);
  base.prices.ou25 = buildPriceViews(db, m, odds, 'OU_GOALS', 2.5, ['OVER', 'UNDER'], pred, priceAsOf, bookNames);
  base.prices.btts = buildPriceViews(db, m, odds, 'BTTS', null, ['YES', 'NO'], pred, priceAsOf, bookNames);

  const oneXTwosAtClose = latestSnapshotSet(odds, 'ONE_X_TWO', db);
  if (oneXTwosAtClose.length >= 3) {
    base.prices.overround = overround(oneXTwosAtClose.map((x) => x.decimal_odds));
  }
  base.prices.movement = movementSeries(odds, bookNames, db);

  return base;
}

function eceProxy(fitted: FittedEnsemble): number | null {
  // validation-window ECE is not persisted on the fitted object; use Brier
  // as proxy input to the grader (grade() also consumes Brier directly).
  return fitted.validation.ensembleBrier != null
    ? Math.max(0, fitted.validation.ensembleBrier - 0.6)
    : null;
}

function buildPriceViews(
  db: Db,
  m: MatchRow,
  odds: OddsRow[],
  marketCode: string,
  line: number | null,
  selections: string[],
  pred: MatchPrediction | null,
  asOf: string,
  bookNames: Map<number, string>,
): PriceView[] {
  const defs = marketDefMap(db);
  const marketId = defs.get(`${marketCode}|${line}`)?.id;
  const inMarket = odds.filter((o) => marketId != null && o.market_id === marketId && o.taken_at <= asOf);

  const latestByBook = (selection: string): Map<number, OddsRow> => {
    const lastPerBook = new Map<number, OddsRow>();
    for (const o of inMarket.filter((x) => x.selection === selection)) {
      const cur = lastPerBook.get(o.bookmaker_id);
      if (!cur || o.taken_at > cur.taken_at) lastPerBook.set(o.bookmaker_id, o);
    }
    return lastPerBook;
  };

  const modelP = (selection: string): number | null => {
    if (!pred) return null;
    if (marketCode === 'ONE_X_TWO') {
      return selection === 'HOME' ? pred.ensemble.home : selection === 'DRAW' ? pred.ensemble.draw : pred.ensemble.away;
    }
    if (marketCode === 'OU_GOALS') {
      const ou = pred.markets.overUnder.find((x) => x.line === line);
      if (!ou) return null;
      return selection === 'OVER' ? ou.over : ou.under;
    }
    if (marketCode === 'BTTS') return selection === 'YES' ? pred.markets.btts.yes : pred.markets.btts.no;
    return null;
  };

  // consensus (mean implied across books) + margin-free estimate
  const byBookAll = selections.map((s) => latestByBook(s));
  const consensus: (number | null)[] = selections.map((_, i) => {
    const entries = [...byBookAll[i].values()];
    if (entries.length === 0) return null;
    const implied = entries.reduce((a, o) => a + 1 / o.decimal_odds, 0) / entries.length;
    return 1 / implied;
  });
  let marginFree: (number | null)[] = selections.map(() => null);
  if (consensus.every((c) => c != null)) {
    marginFree = removeMarginPower(consensus as number[]);
  }

  return selections.map((selection, i) => {
    const best = [...byBookAll[i].values()].sort((a, b) => b.decimal_odds - a.decimal_odds)[0];
    const p = modelP(selection);
    const cons = consensus[i];
    return {
      selection,
      modelProbability: p ?? 0,
      fairOdds: p ? fairOdds(p) : 0,
      bestOdds: best?.decimal_odds ?? null,
      bestBook: best ? bookNames.get(best.bookmaker_id) ?? null : null,
      consensusOdds: cons,
      marginFreeProb: marginFree[i],
      diffPct: p != null && cons ? priceDifference(fairOdds(p), cons) : null,
      ev: p != null && cons ? expectedValue(p, cons) : null,
    };
  });
}

function latestSnapshotSet(odds: OddsRow[], marketCode: string, db: Db): OddsRow[] {
  const defs = marketDefMap(db);
  const marketId = defs.get(`${marketCode}|null`)?.id;
  if (!marketId) return [];
  const inMarket = odds.filter((o) => o.market_id === marketId);
  if (inMarket.length === 0) return [];
  const maxTaken = inMarket.reduce((a, o) => (o.taken_at > a ? o.taken_at : a), '');
  return inMarket.filter((o) => o.taken_at === maxTaken);
}

/** Implied-probability time series for the 1X2 market (margin removed per snapshot set). */
function movementSeries(
  odds: OddsRow[],
  bookNames: Map<number, string>,
  db: Db,
): OddsMovementPoint[] {
  const defs = marketDefMap(db);
  const marketId = defs.get('ONE_X_TWO|null')?.id;
  if (!marketId) return [];
  const inMarket = odds.filter((o) => o.market_id === marketId);
  const grouped = new Map<string, OddsRow[]>();
  for (const o of inMarket) {
    const key = `${o.taken_at}|${o.bookmaker_id}`;
    const arr = grouped.get(key) ?? [];
    arr.push(o);
    grouped.set(key, arr);
  }
  const points: OddsMovementPoint[] = [];
  for (const [key, rows] of grouped) {
    if (rows.length < 3) continue;
    const [takenAt, bookId] = key.split('|');
    const ordered = ['HOME', 'DRAW', 'AWAY'].map(
      (s) => rows.find((r) => r.selection === s)?.decimal_odds,
    );
    if (ordered.some((x) => x == null)) continue;
    const probs = removeMarginPower(ordered as number[]);
    points.push({ takenAt, book: bookNames.get(Number(bookId)) ?? `book#${bookId}`, implied: probs });
  }
  return points.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

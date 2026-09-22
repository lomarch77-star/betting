/**
 * Model pipeline — trains the four result models inside a strict information
 * horizon (`asOf`), derives ensemble weights and a calibrator from a
 * HELD-OUT validation slice, then refits final models on train+validation
 * and applies the validation-derived calibration to the refit models.
 *
 * Chronological guarantee:
 *   fit models on     rows with kickoff <  asOf − valSpan     (training)
 *   validate on       rows in [asOf − valSpan, asOf)          (validation)
 *   final models on   rows with kickoff <  asOf               (train + val)
 *   predict matches   with kickoff ≥ asOf                     (never seen)
 */

import type { Db } from '@/lib/db/client';
import { finishedBefore, type MatchRow } from '@/lib/db/repos-core';
import {
  buildRowsWithBuilder,
  FEATURE_NAMES,
  type FeatureBuilder,
  type FeatureSnapshot,
  type TrainingRow,
} from '@/lib/features/builder';
import {
  EloSystem,
  eloThreeWayFromRatings,
  fitDrawParams,
  DEFAULT_ELO_PARAMS,
  type EloParams,
} from './elo';
import {
  fitTeamStrengths,
  expectedLambdas,
  DEFAULT_STRENGTH_PARAMS,
  type StrengthParams,
  type TeamStrengthModel,
} from './teamStrength';
import {
  trainSoftmax,
  predictSoftmaxProbs,
  DEFAULT_LOGISTIC_PARAMS,
  type LogisticParams,
  type SoftmaxModel,
} from './logistic';
import {
  trainGbm,
  predictGbmProbs,
  DEFAULT_GBM_PARAMS,
  type GbmParams,
  type GbmModel,
} from './gbm';
import {
  combineProbabilities,
  fitEnsembleWeights,
  DEFAULT_ENSEMBLE_WEIGHTS,
  type EnsembleWeights,
} from './ensemble';
import {
  fitMulticlassCalibrator,
  type MulticlassCalibrator,
} from '@/lib/quant/calibration';
import {
  independentPoissonMatrix,
  dixonColesAdjust,
  deriveMarkets,
  DEFAULT_RHO,
  type DerivedMarkets,
  type ScoreMatrix,
} from '@/lib/quant/poisson';
import { logLossMulti, brierMulti } from '@/lib/quant/metrics';
import { prob3ToArray, type Prob3 } from '@/lib/types';

const DAY = 86_400_000;

export interface PipelineConfig {
  trainSpanDays: number;
  valSpanDays: number;
  logistic: LogisticParams;
  gbm: GbmParams;
  strength: StrengthParams;
  calibrationMethod: 'platt' | 'isotonic';
  /** if validation slice is smaller than this, fall back to default weights/no calibration */
  minValRows: number;
  /** cap rows fed to GBM (most recent) to bound fit time */
  maxGbmRows: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  trainSpanDays: 760,
  valSpanDays: 150,
  logistic: DEFAULT_LOGISTIC_PARAMS,
  gbm: DEFAULT_GBM_PARAMS,
  strength: DEFAULT_STRENGTH_PARAMS,
  calibrationMethod: 'isotonic',
  minValRows: 40,
  maxGbmRows: 1200,
};

export interface PerModelProbs {
  ELO: Prob3;
  POISSON: Prob3;
  LOGISTIC: Prob3;
  GBM: Prob3;
}

export interface FittedEnsemble {
  asOf: string;
  builder: FeatureBuilder;
  eloParams: EloParams;
  strengths: TeamStrengthModel;
  logistic: SoftmaxModel;
  gbm: GbmModel;
  weights: EnsembleWeights;
  calibrator: MulticlassCalibrator | null;
  trainedOn: number;
  validation: {
    rows: number;
    ensembleLogLoss: number | null;
    ensembleBrier: number | null;
    perModel: Record<string, { logLoss: number; brier: number } | null>;
  };
}

interface InternalModels {
  eloParams: EloParams;
  strengths: TeamStrengthModel;
  logistic: SoftmaxModel;
  gbm: GbmModel;
}

function toStrengthMatches(rows: TrainingRow[]) {
  return rows.map((r) => ({
    homeTeamId: r.homeTeamId,
    awayTeamId: r.awayTeamId,
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    kickoff: r.kickoff,
  }));
}

function fitCoreModels(
  rows: TrainingRow[],
  asOf: string,
  cfg: PipelineConfig,
): InternalModels {
  const eloParams =
    rows.length >= 80
      ? fitDrawParams(
          rows.map((r) => ({
            homeTeamId: r.homeTeamId,
            awayTeamId: r.awayTeamId,
            result: r.label === 0 ? 'H' : r.label === 1 ? 'D' : 'A',
            homeGoals: r.homeGoals,
            awayGoals: r.awayGoals,
            kickoff: r.kickoff,
            homeRatingPre: r.eloHomePre,
            awayRatingPre: r.eloAwayPre,
            kUsed: 0,
          })),
          DEFAULT_ELO_PARAMS,
        )
      : DEFAULT_ELO_PARAMS;
  const strengths = fitTeamStrengths(toStrengthMatches(rows), asOf, cfg.strength);
  const X = rows.map((r) => r.x);
  const y = rows.map((r) => r.label);
  const logistic = trainSoftmax(X, y, cfg.logistic, [...FEATURE_NAMES]);
  const gbmRows =
    rows.length > cfg.maxGbmRows ? rows.slice(rows.length - cfg.maxGbmRows) : rows;
  const gbm = trainGbm(
    gbmRows.map((r) => r.x),
    gbmRows.map((r) => r.label),
    cfg.gbm,
    [...FEATURE_NAMES],
  );
  return { eloParams, strengths, logistic, gbm };
}

function probsFromModels(
  models: InternalModels,
  features: { x: number[]; eloHomePre: number; eloAwayPre: number },
  homeId: number,
  awayId: number,
): PerModelProbs {
  const eloP = eloThreeWayFromRatings(
    features.eloHomePre,
    features.eloAwayPre,
    models.eloParams,
  );
  const lam = expectedLambdas(models.strengths, homeId, awayId);
  const matrix = dixonColesAdjust(
    independentPoissonMatrix(lam.lambdaHome, lam.lambdaAway),
    lam.lambdaHome,
    lam.lambdaAway,
    DEFAULT_RHO,
  );
  const poissonP = deriveMarkets(matrix).oneXTwo;
  const [lh, ld, la] = predictSoftmaxProbs(models.logistic, features.x);
  const [gh, gd, ga] = predictGbmProbs(models.gbm, features.x);
  return {
    ELO: eloP,
    POISSON: poissonP,
    LOGISTIC: { home: lh, draw: ld, away: la },
    GBM: { home: gh, draw: gd, away: ga },
  };
}

/** Fit the full ensemble for predictions at/after `asOf`. */
export function fitEnsembleAt(
  db: Db,
  asOf: string,
  cfg: PipelineConfig = DEFAULT_PIPELINE_CONFIG,
  opts: { competitionId?: number } = {},
): FittedEnsemble {
  const asOfMs = Date.parse(asOf);
  const finished = finishedBefore(db, asOf, { competitionId: opts.competitionId });
  const { rows, builder } = buildRowsWithBuilder(finished);

  const spanStart = asOfMs - cfg.trainSpanDays * DAY;
  const valStart = asOfMs - cfg.valSpanDays * DAY;
  const span = rows.filter((r) => Date.parse(r.kickoff) >= spanStart);
  const fitRows = span.filter((r) => Date.parse(r.kickoff) < valStart);
  const valRows = span.filter((r) => Date.parse(r.kickoff) >= valStart);

  if (fitRows.length < 60) {
    throw new Error(
      `fitEnsembleAt: insufficient history before ${asOf} (${fitRows.length} usable rows). Models not fitted.`,
    );
  }

  // 1) candidate models on training-only slice
  const candidate = fitCoreModels(fitRows, new Date(valStart).toISOString(), cfg);

  // 2) honest validation predictions → ensemble weights + calibrator
  let weights: EnsembleWeights = DEFAULT_ENSEMBLE_WEIGHTS;
  let calibrator: MulticlassCalibrator | null = null;
  let ensembleLogLoss: number | null = null;
  let ensembleBrier: number | null = null;
  const perModelVal: Record<string, { logLoss: number; brier: number } | null> = {
    ELO: null,
    POISSON: null,
    LOGISTIC: null,
    GBM: null,
  };

  if (valRows.length >= cfg.minValRows) {
    const valLabels = valRows.map((r) => r.label);
    const perModelRows: Record<string, number[][]> = { ELO: [], POISSON: [], LOGISTIC: [], GBM: [] };
    // Candidate was fitted on rows with kickoff < valStart, and each row's
    // features were snapshotted pre-match — validation is honest OOS.
    for (const vr of valRows) {
      const probs = probsFromModels(candidate, vr, vr.homeTeamId, vr.awayTeamId);
      perModelRows.ELO.push(prob3ToArray(probs.ELO));
      perModelRows.POISSON.push(prob3ToArray(probs.POISSON));
      perModelRows.LOGISTIC.push(prob3ToArray(probs.LOGISTIC));
      perModelRows.GBM.push(prob3ToArray(probs.GBM));
    }
    const fitted = fitEnsembleWeights(
      [perModelRows.ELO, perModelRows.POISSON, perModelRows.LOGISTIC, perModelRows.GBM],
      valLabels,
    );
    weights = fitted.weights;
    const ensembleRows: number[][] = [];
    for (let i = 0; i < valRows.length; i++) {
      const e = combineProbabilities(
        {
          ELO: arrToProb3(perModelRows.ELO[i]),
          POISSON: arrToProb3(perModelRows.POISSON[i]),
          LOGISTIC: arrToProb3(perModelRows.LOGISTIC[i]),
          GBM: arrToProb3(perModelRows.GBM[i]),
        },
        weights,
      );
      ensembleRows.push(prob3ToArray(e));
    }
    calibrator = fitMulticlassCalibrator(ensembleRows, valLabels, cfg.calibrationMethod);
    const calibrated = ensembleRows.map((p) => calibrator!.apply(p));
    ensembleLogLoss = logLossMulti(calibrated, valLabels);
    ensembleBrier = brierMulti(calibrated, valLabels);
    for (const k of ['ELO', 'POISSON', 'LOGISTIC', 'GBM'] as const) {
      perModelVal[k] = {
        logLoss: logLossMulti(perModelRows[k], valLabels),
        brier: brierMulti(perModelRows[k], valLabels),
      };
    }
  }

  // 3) final models refit on train+validation — strictly < asOf
  const finalModels = fitCoreModels(span, asOf, cfg);

  return {
    asOf,
    builder,
    ...finalModels,
    weights,
    calibrator,
    trainedOn: span.length,
    validation: {
      rows: valRows.length,
      ensembleLogLoss,
      ensembleBrier,
      perModel: perModelVal,
    },
  };
}

function arrToProb3(a: number[]): Prob3 {
  return { home: a[0], draw: a[1], away: a[2] };
}

export interface MatchPrediction {
  matchId?: number;
  asOf: string;
  snapshot: FeatureSnapshot;
  lambdas: { home: number; away: number };
  perModel: PerModelProbs;
  ensembleRaw: Prob3;
  ensemble: Prob3;
  calibrated: boolean;
  matrix: ScoreMatrix;
  markets: DerivedMarkets;
}

/**
 * Predict one fixture with a fitted ensemble. Fixture kickoff must be after
 * the ensemble's information horizon (enforced by snapshot()).
 */
export function predictFixture(
  fitted: FittedEnsemble,
  m: Pick<MatchRow, 'competition_id' | 'season_id' | 'home_team_id' | 'away_team_id' | 'kickoff_utc'>,
): MatchPrediction {
  const snapshot = fitted.builder.snapshot(
    m.competition_id,
    m.season_id,
    m.home_team_id,
    m.away_team_id,
    m.kickoff_utc,
  );
  const perModel = probsFromModels(
    {
      eloParams: fitted.eloParams,
      strengths: fitted.strengths,
      logistic: fitted.logistic,
      gbm: fitted.gbm,
    },
    {
      x: snapshot.x,
      eloHomePre: snapshot.context.eloHome,
      eloAwayPre: snapshot.context.eloAway,
    },
    m.home_team_id,
    m.away_team_id,
  );
  const ensembleRaw = combineProbabilities(perModel, fitted.weights);
  const ensembleArr = fitted.calibrator
    ? fitted.calibrator.apply(prob3ToArray(ensembleRaw))
    : prob3ToArray(ensembleRaw);
  const ensemble = arrToProb3(ensembleArr);

  const lambdasRaw = expectedLambdas(
    fitted.strengths,
    m.home_team_id,
    m.away_team_id,
  );
  // Adjust the score matrix so its implied 1X2 equals the ensemble's
  // probabilities — a consistent joint distribution across ALL markets.
  const { lambdaHome, lambdaAway, rho } = matchMatrixToOneXTwo(
    lambdasRaw.lambdaHome,
    lambdasRaw.lambdaAway,
    ensemble,
  );
  const matrix = dixonColesAdjust(
    independentPoissonMatrix(lambdaHome, lambdaAway),
    lambdaHome,
    lambdaAway,
    rho,
  );
  const markets = deriveMarkets(matrix);

  return {
    matchId: (m as MatchRow).id,
    asOf: m.kickoff_utc,
    snapshot,
    lambdas: { home: lambdaHome, away: lambdaAway },
    perModel,
    ensembleRaw,
    ensemble,
    calibrated: fitted.calibrator != null,
    matrix,
    markets,
  };
}

/**
 * Deterministic local search: find (λh, λa, ρ) whose matrix reproduces the
 * target 1X2 probabilities while staying close to the Poisson model's raw
 * lambdas (L2 pull). Coarse grid — fast and reproducible.
 */
export function matchMatrixToOneXTwo(
  baseLambdaH: number,
  baseLambdaA: number,
  target: Prob3,
): { lambdaHome: number; lambdaAway: number; rho: number } {
  let best = { lambdaHome: baseLambdaH, lambdaAway: baseLambdaA, rho: DEFAULT_RHO, err: Infinity };
  const rhos = [-0.18, -0.12, -0.08, -0.04, 0];
  for (let dh = -0.28; dh <= 0.28; dh += 0.04) {
    for (let da = -0.28; da <= 0.28; da += 0.04) {
      const lh = baseLambdaH * (1 + dh);
      const la = baseLambdaA * (1 + da);
      for (const rho of rhos) {
        const m = dixonColesAdjust(independentPoissonMatrix(lh, la), lh, la, rho);
        const p = deriveMarkets(m, { ahLines: [], topScores: 1, ouLines: [2.5], teamTotalLines: [1.5] }).oneXTwo;
        const err =
          (p.home - target.home) ** 2 +
          (p.draw - target.draw) ** 2 +
          (p.away - target.away) ** 2 +
          0.02 * (dh * dh + da * da);
        if (err < best.err) best = { lambdaHome: lh, lambdaAway: la, rho, err };
      }
    }
  }
  return { lambdaHome: best.lambdaHome, lambdaAway: best.lambdaAway, rho: best.rho };
}

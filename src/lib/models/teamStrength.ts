/**
 * Poisson attack/defence strength model (spec §8).
 *
 * Maximum-likelihood fit of per-team attack & defence strengths with
 * exponential time decay (matches from the distant past are down-weighted),
 * Dixon–Coles style. Fits:
 *
 *   λ_home = exp(homeLogAdv + att[h] + def[a])
 *   λ_away = exp(att[a] + def[h])                    (def is log-space, ≤ 0 better)
 *
 * Parameters are optimised by gradient ascent on the weighted log-likelihood
 * with attack and defence vectors re-centred to sum zero each step.
 * Deterministic: fixed iteration schedule, no randomness.
 *
 * The architecture deliberately separates the STRENGTH ESTIMATOR (this file)
 * from the DISTRIBUTION ASSUMPTION (lib/quant/poisson.ts), so negative
 * binomial / Bayesian hierarchical variants can be added later without
 * touching market derivation.
 */

export interface StrengthMatch {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  kickoff: string; // ISO
}

export interface StrengthParams {
  halfLifeDays: number; // time-decay half-life
  iterations: number;
  learningRate: number;
  priorStrength: number; // L2 shrinkage toward 0 (new teams = league avg)
}

export const DEFAULT_STRENGTH_PARAMS: StrengthParams = {
  halfLifeDays: 548, // ~1.5 seasons
  iterations: 300,
  learningRate: 0.02,
  priorStrength: 40,
};

export interface TeamStrengthModel {
  attack: Map<number, number>;
  defence: Map<number, number>;
  homeLogAdv: number;
  leagueAvgGoals: number; // exp of fitted baseline, for shrinkage of unseen teams
  trainedOn: number; // match count
  teamIds: number[];
}

const DAY_MS = 86_400_000;

export function fitTeamStrengths(
  matches: StrengthMatch[],
  asOfIso: string,
  params: StrengthParams = DEFAULT_STRENGTH_PARAMS,
): TeamStrengthModel {
  const asOfMs = Date.parse(asOfIso);
  const teamIds = [...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]))].sort(
    (a, b) => a - b,
  );
  const idx = new Map(teamIds.map((t, i) => [t, i]));
  const T = teamIds.length;
  const att = new Array<number>(T).fill(0);
  const def = new Array<number>(T).fill(0);
  let homeLogAdv = 0.25;

  // Precompute decay weights relative to asOf (never uses data after asOf —
  // the caller guarantees the slice is already restricted).
  const w = matches.map((m) =>
    Math.pow(0.5, Math.max(0, (asOfMs - Date.parse(m.kickoff)) / DAY_MS) / params.halfLifeDays),
  );

  const gradAtt = new Array<number>(T).fill(0);
  const gradDef = new Array<number>(T).fill(0);

  for (let iter = 0; iter < params.iterations; iter++) {
    gradAtt.fill(0);
    gradDef.fill(0);
    let gHome = 0;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const hi = idx.get(m.homeTeamId)!;
      const ai = idx.get(m.awayTeamId)!;
      const lamH = Math.exp(homeLogAdv + att[hi] + def[ai]);
      const lamA = Math.exp(att[ai] + def[hi]);
      const wi = w[i];
      // dLL/dθ for Poisson: w·(goals − λ)
      gradAtt[hi] += wi * (m.homeGoals - lamH);
      gradDef[ai] += wi * (m.homeGoals - lamH);
      gHome += wi * (m.homeGoals - lamH);
      gradAtt[ai] += wi * (m.awayGoals - lamA);
      gradDef[hi] += wi * (m.awayGoals - lamA);
    }
    const lr = params.learningRate / (1 + 0.01 * Math.sqrt(iter));
    const n = Math.max(1, matches.length);
    for (let t = 0; t < T; t++) {
      att[t] += (lr / n) * (gradAtt[t] - params.priorStrength * 0.01 * att[t] * n * 0.001);
      def[t] += (lr / n) * (gradDef[t] - params.priorStrength * 0.01 * def[t] * n * 0.001);
    }
    homeLogAdv += (lr / n) * gHome;
    // identifiability: centre attack & defence
    const mAtt = att.reduce((a, b) => a + b, 0) / T;
    const mDef = def.reduce((a, b) => a + b, 0) / T;
    for (let t = 0; t < T; t++) {
      att[t] -= mAtt;
      def[t] -= mDef;
    }
  }

  // League average goals per team per match (time-weighted), for priors.
  let gs = 0, wsum = 0;
  for (let i = 0; i < matches.length; i++) {
    gs += w[i] * (matches[i].homeGoals + matches[i].awayGoals);
    wsum += w[i];
  }
  const leagueAvgGoals = wsum > 0 ? gs / (2 * wsum) : 1.35;

  return {
    attack: new Map(teamIds.map((t, i) => [t, att[i]])),
    defence: new Map(teamIds.map((t, i) => [t, def[i]])),
    homeLogAdv: Math.max(-0.5, Math.min(homeLogAdv, 0.9)),
    leagueAvgGoals,
    trainedOn: matches.length,
    teamIds,
  };
}

/** Expected goals for a fixture. Unseen teams fall back to neutral (0). */
export function expectedLambdas(
  model: TeamStrengthModel,
  homeId: number,
  awayId: number,
): { lambdaHome: number; lambdaAway: number } {
  const attH = model.attack.get(homeId) ?? 0;
  const defH = model.defence.get(homeId) ?? 0;
  const attA = model.attack.get(awayId) ?? 0;
  const defA = model.defence.get(awayId) ?? 0;
  return {
    lambdaHome: Math.exp(model.homeLogAdv + attH + defA),
    lambdaAway: Math.exp(attA + defH),
  };
}

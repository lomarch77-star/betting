/**
 * Dashboard aggregation + deterministic analyst narrative.
 */

import type { Db } from '@/lib/db/client';
import { countMatchesByStatus, latestKickoff, upcomingMatches } from '@/lib/db/repos-core';
import {
  listModelVersions,
  countPredictions,
  listExperiments,
  listBacktestRuns,
  latestDqReport,
  listEdges,
} from '@/lib/db/repos-research';
import { portfolioReport } from './portfolioService';
import { standardEnsemble } from './predictionService';
import type { MatchAnalysis } from './predictionService';

export async function dashboardSummary(db: Db) {
  const statusCounts = countMatchesByStatus(db);
  const predictions = countPredictions(db);
  const models = listModelVersions(db);
  const latest = latestKickoff(db);
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const upcoming7 = upcomingMatches(db, now, horizon);
  const experiments = listExperiments(db);
  const backtests = listBacktestRuns(db);
  const dq = latestDqReport(db);
  const edges = listEdges(db);
  const portfolio = portfolioReport(db);
  const marketRows = db.prepare('SELECT COUNT(*) AS c FROM market_defs').get() as { c: number };
  const oddsRows = db.prepare('SELECT COUNT(*) AS c FROM odds_snapshots').get() as { c: number };
  const latestOdds = db.prepare('SELECT MAX(taken_at) AS t FROM odds_snapshots').get() as {
    t: string | null;
  };

  const std = await standardEnsemble(db);
  const latestComplete = backtests.find((b) => b.status === 'COMPLETE');

  return {
    today: {
      date: now.slice(0, 10),
      matchesAnalyzed: predictions,
      matchesUpcoming7d: upcoming7.length,
      modelsRunning: models.length,
      marketsTracked: marketRows.c,
      oddsSnapshots: oddsRows.c,
      dataFreshness: {
        latestFinishedKickoff: latest,
        latestOddsSnapshot: latestOdds.t,
      },
      activeExperiments: experiments.filter((e) => ['PROMISING', 'VALIDATING'].includes(e.status)).length,
      totalExperiments: experiments.length,
      validationStatus: latestComplete
        ? { code: latestComplete.code, finishedAt: latestComplete.finished_at }
        : null,
      paperPortfolio: {
        current: portfolio.current,
        initial: portfolio.initial,
        roi: portfolio.metrics.roi,
        openEntries: portfolio.openCount,
        settledSelections: portfolio.metrics.selections,
      },
    },
    modelHealth: {
      ensemble: {
        fittedAt: std.asOf,
        trainedOn: std.fitted.trainedOn,
        weights: std.fitted.weights,
        validation: std.fitted.validation,
      },
      latestBacktest: latestComplete
        ? {
            id: latestComplete.id,
            code: latestComplete.code,
            name: latestComplete.name,
            metrics: latestComplete.metrics_json ? JSON.parse(latestComplete.metrics_json) : null,
          }
        : null,
      dataQuality: dq
        ? { runAt: dq.run_at, valid: dq.valid_count, warnings: dq.warning_count, invalid: dq.invalid_count }
        : null,
      edges: {
        total: edges.length,
        byStatus: edges.reduce<Record<string, number>>((acc, e) => {
          acc[e.status] = (acc[e.status] ?? 0) + 1;
          return acc;
        }, {}),
      },
    },
  };
}

// ─── Deterministic analyst narrative (rules-based; no LLM) ──────────────────
//
// Spec §24 constraints implemented by construction: this module reads ONLY
// the structured MatchAnalysis object. It cannot invent injuries, form, or
// prices, because it has no capability to reference anything else. An LLM
// adapter may later rephrase these bullets, but the numeric payload is fixed
// here — fabrication would require changing this code.

export interface AnalystOutput {
  engine: 'deterministic-templates-v1';
  disclaimer: string;
  summary: string;
  bullets: Array<{ tag: string; text: string }>;
  evidence: Array<{ field: string; value: string }>;
}

export function analystSummary(a: MatchAnalysis): AnalystOutput {
  const bullets: AnalystOutput['bullets'] = [];
  const evidence: AnalystOutput['evidence'] = [];
  const m = a.match;
  const p = a.prediction;

  evidence.push({ field: 'match.kickoff', value: m.kickoff });
  evidence.push({ field: 'match.qualityStatus', value: m.qualityStatus });

  if (!p) {
    return {
      engine: 'deterministic-templates-v1',
      disclaimer:
        'Rules-based summary over structured model outputs. Not betting advice; probabilities are estimates, not certainties.',
      summary: `No model coverage is available for ${m.homeTeam} vs ${m.awayTeam} (insufficient historical data at the required information horizon).`,
      bullets: [],
      evidence,
    };
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const [ph, pd, pa] = [p.ensemble.home, p.ensemble.draw, p.ensemble.away];
  const fav =
    ph >= pd && ph >= pa ? m.homeTeam : pa >= ph && pa >= pd ? m.awayTeam : 'the draw';
  const favP = Math.max(ph, pd, pa);

  const summary =
    `${m.homeTeam} vs ${m.awayTeam} (${m.competition} ${m.seasonCode}, round ${m.round}). ` +
    `The calibrated ensemble assigns ${pct(ph)} home / ${pct(pd)} draw / ${pct(pa)} away, ` +
    `making ${fav} the most likely outcome at ${pct(favP)} — a probability, not a certainty. ` +
    `Fair prices implied by the model are ${p.fair.home.toFixed(2)} / ${p.fair.draw.toFixed(2)} / ${p.fair.away.toFixed(2)}.`;

  evidence.push({ field: 'prediction.ensemble', value: `${pct(ph)} / ${pct(pd)} / ${pct(pa)}` });

  // market divergence
  const divergences = a.prices.oneXTwo
    .filter((v) => v.diffPct != null)
    .sort((x, y) => Math.abs(y.diffPct!) - Math.abs(x.diffPct!));
  if (divergences[0]) {
    const d = divergences[0];
    bullets.push({
      tag: 'price-divergence',
      text:
        `Largest model/market divergence: ${d.selection} — model ${pct(d.modelProbability)} vs margin-free market ${d.consensusOdds != null ? pct(1 / d.consensusOdds) : 'n/a'} ` +
        `(${d.diffPct! >= 0 ? '+' : ''}${(d.diffPct! * 100).toFixed(1)}% relative price difference at consensus odds ${d.consensusOdds?.toFixed(2)}). ` +
        `Divergence is a research signal, not an instruction.`,
    });
    evidence.push({ field: 'prices.oneXTwo.maxDiffPct', value: `${(d.diffPct! * 100).toFixed(1)}%` });
  }

  // agreement
  bullets.push({
    tag: 'model-agreement',
    text: `Model agreement is ${p.uncertainty.modelAgreement} (mean pairwise spread ${(
      p.uncertainty.meanSpread * 100
    ).toFixed(1)}pp across ELO / Poisson / Logistic / GBM). ${
      p.uncertainty.modelAgreement === 'SPLIT'
        ? 'Divergence across components reduces confidence in any single estimate.'
        : 'Independent components broadly agree, which stabilises the estimate.'
    }`,
  });
  evidence.push({ field: 'prediction.uncertainty.modelAgreement', value: p.uncertainty.modelAgreement });

  // expected goals
  bullets.push({
    tag: 'expected-goals',
    text: `Scoreline distribution centres on xĜ ${p.expectedGoalsFromMatrix.home.toFixed(2)} – ${p.expectedGoalsFromMatrix.away.toFixed(2)}; most likely exact score ${
      p.matrixTop[0] ? `${p.matrixTop[0].home}-${p.matrixTop[0].away} (${pct(p.matrixTop[0].prob)})` : 'n/a'
    }.`,
  });
  evidence.push({ field: 'prediction.expectedGoalsFromMatrix', value: `${p.expectedGoalsFromMatrix.home.toFixed(2)} / ${p.expectedGoalsFromMatrix.away.toFixed(2)}` });

  // drivers
  for (const e of p.explanation.slice(0, 3)) {
    bullets.push({ tag: e.direction === '+' ? 'driver:pro-home' : 'driver:pro-away', text: e.text });
  }

  // uncertainty notes
  for (const note of p.uncertainty.notes) {
    bullets.push({ tag: 'uncertainty', text: note });
  }
  evidence.push({ field: 'prediction.trainedOn', value: String(p.trainedOn) });

  return {
    engine: 'deterministic-templates-v1',
    disclaimer:
      'Rules-based summary over structured model outputs — every number above is traceable to a stored data object. Not betting advice; probabilities are estimates, not certainties.',
    summary,
    bullets,
    evidence,
  };
}

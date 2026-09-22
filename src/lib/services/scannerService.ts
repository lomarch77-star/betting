/**
 * Market scanner service (spec §25).
 *
 * Computes, for each upcoming fixture, model-vs-market comparisons across
 * price-supported markets. Filters are measurable fields ONLY — the product
 * deliberately never ranks by "best bet".
 */

import type { Db } from '@/lib/db/client';
import {
  upcomingMatches,
  consensusEntryPrice,
  marketDefMap,
  teamById,
} from '@/lib/db/repos-core';
import { standardEnsemble } from './predictionService';
import { predictFixture, type MatchPrediction } from '@/lib/models/pipeline';
import { assessDisagreement } from '@/lib/quant/uncertainty';
import { fairOdds, priceDifference, expectedValue } from '@/lib/quant/pricing';
import { prob3ToArray } from '@/lib/types';

export interface ScannerRow {
  matchId: number;
  kickoff: string;
  competitionCode: string;
  competitionName: string;
  homeTeam: string;
  awayTeam: string;
  homeShort: string;
  awayShort: string;
  market: string;
  line: number | null;
  selection: string;
  modelProbability: number;
  fairOdds: number;
  consensusOdds: number | null;
  bookCount: number;
  diffPct: number | null;
  ev: number | null;
  agreement: 'BROAD' | 'MODERATE' | 'SPLIT';
  dataQuality: string;
  trainedOn: number;
}

export interface ScannerQuery {
  market?: 'ONE_X_TWO' | 'OU_GOALS' | 'BTTS';
  competitionId?: number;
  minAbsDiffPct?: number;
  minEv?: number;
  agreement?: 'BROAD' | 'MODERATE' | 'SPLIT';
  quality?: 'VALID' | 'WARNING';
  sortBy?: 'diffPct' | 'ev' | 'modelProbability' | 'kickoff';
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

export async function runScanner(db: Db, q: ScannerQuery): Promise<ScannerRow[]> {
  const std = await standardEnsemble(db);
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const matches = upcomingMatches(db, now, horizon, {
    competitionId: q.competitionId,
  }).filter((m) => m.quality_status !== 'INVALID');

  const defs = marketDefMap(db);
  const rows: ScannerRow[] = [];
  const compNames = new Map<number, { code: string; name: string }>();
  for (const c of db.prepare('SELECT id, code, name FROM competitions').all() as Array<{
    id: number;
    code: string;
    name: string;
  }>) {
    compNames.set(c.id, { code: c.code, name: c.name });
  }

  for (const m of matches) {
    let pred: MatchPrediction;
    try {
      pred = predictFixture(std.fitted, m);
    } catch {
      continue;
    }
    const agreement = assessDisagreement([
      { kind: 'ELO', probs: pred.perModel.ELO },
      { kind: 'POISSON', probs: pred.perModel.POISSON },
      { kind: 'LOGISTIC', probs: pred.perModel.LOGISTIC },
      { kind: 'GBM', probs: pred.perModel.GBM },
    ]).label;
    const home = teamById(db, m.home_team_id);
    const away = teamById(db, m.away_team_id);
    const comp = compNames.get(m.competition_id)!;

    const asOf = now;
    const emit = (
      market: string,
      line: number | null,
      selection: string,
      p: number,
    ) => {
      if (q.market && q.market !== market) return;
      const marketId = defs.get(`${market}|${line}`)?.id;
      const price = marketId != null
        ? consensusEntryPrice(db, m.id, marketId, selection, asOf)
        : null;
      const diff = price ? priceDifference(fairOdds(p), price.odds) : null;
      const ev = price ? expectedValue(p, price.odds) : null;
      rows.push({
        matchId: m.id,
        kickoff: m.kickoff_utc,
        competitionCode: comp.code,
        competitionName: comp.name,
        homeTeam: home?.canonical_name ?? '?',
        awayTeam: away?.canonical_name ?? '?',
        homeShort: home?.short_name ?? '?',
        awayShort: away?.short_name ?? '?',
        market,
        line,
        selection,
        modelProbability: p,
        fairOdds: fairOdds(p),
        consensusOdds: price?.odds ?? null,
        bookCount: price?.bookCount ?? 0,
        diffPct: diff,
        ev,
        agreement,
        dataQuality: m.quality_status,
        trainedOn: std.fitted.trainedOn,
      });
    };

    const [ph, pd, pa] = prob3ToArray(pred.ensemble);
    emit('ONE_X_TWO', null, 'HOME', ph);
    emit('ONE_X_TWO', null, 'DRAW', pd);
    emit('ONE_X_TWO', null, 'AWAY', pa);
    const ou = pred.markets.overUnder.find((o) => o.line === 2.5);
    if (ou) {
      emit('OU_GOALS', 2.5, 'OVER', ou.over);
      emit('OU_GOALS', 2.5, 'UNDER', ou.under);
    }
    emit('BTTS', null, 'YES', pred.markets.btts.yes);
    emit('BTTS', null, 'NO', pred.markets.btts.no);
  }

  let filtered = rows;
  if (q.minAbsDiffPct != null) {
    filtered = filtered.filter((r) => r.diffPct != null && Math.abs(r.diffPct) >= q.minAbsDiffPct!);
  }
  if (q.minEv != null) {
    filtered = filtered.filter((r) => r.ev != null && r.ev >= q.minEv!);
  }
  if (q.agreement) filtered = filtered.filter((r) => r.agreement === q.agreement);
  if (q.quality) filtered = filtered.filter((r) => r.dataQuality === q.quality);

  const dir = q.sortDir === 'asc' ? 1 : -1;
  const sortBy = q.sortBy ?? 'diffPct';
  filtered.sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return dir * va.localeCompare(String(vb));
    return dir * (Number(va) - Number(vb));
  });

  return filtered.slice(0, q.limit ?? 300);
}

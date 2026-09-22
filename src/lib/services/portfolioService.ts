/**
 * Paper portfolio service (spec §27) — a simulated, explicitly NOT real-money
 * ledger. Settlements read finished results + closing prices; CLV is
 * reported as a diagnostic, not a profit claim.
 */

import type { Db } from '@/lib/db/client';
import { matchById, closingPrice, marketDefMap } from '@/lib/db/repos-core';
import {
  insertPaperEntry,
  settlePaperEntry,
  listPaperEntries,
  unsettledPaperEntries,
  type PaperEntryRow,
} from '@/lib/db/repos-research';
import { computeBettingMetrics, type SettledBet, type BettingMetrics } from '@/lib/quant/metrics';
import { getSetting, setSetting } from '@/lib/db/repos-research';

const BANKROLL_KEY = 'paper_bankroll_initial';
const DEFAULT_BANKROLL = 1000;

export function initialBankroll(db: Db): number {
  const v = getSetting(db, BANKROLL_KEY);
  if (v == null) {
    setSetting(db, BANKROLL_KEY, String(DEFAULT_BANKROLL));
    return DEFAULT_BANKROLL;
  }
  return Number(v);
}

export function addPaperEntry(
  db: Db,
  e: {
    matchId: number;
    market: string;
    line: number | null;
    selection: string;
    bookmaker: string;
    odds: number;
    modelProbability: number;
    modelVersionId: number | null;
    stake: number;
    notes?: string;
  },
): number {
  const defs = marketDefMap(db);
  const marketId = defs.get(`${e.market}|${e.line}`)?.id;
  if (!marketId) throw new Error(`Unknown market ${e.market} line ${e.line}`);
  return insertPaperEntry(db, {
    match_id: e.matchId,
    market_id: marketId,
    selection: e.selection,
    bookmaker: e.bookmaker,
    odds_at_entry: e.odds,
    model_probability: e.modelProbability,
    model_version_id: e.modelVersionId,
    stake: e.stake,
    entered_at: new Date().toISOString(),
    notes: e.notes ?? null,
  });
}

/**
 * Settle all open entries whose matches have finished. Returns how many
 * were settled. Idempotent.
 */
export function settleDueEntries(db: Db): number {
  const open = unsettledPaperEntries(db);
  let settled = 0;
  for (const e of open) {
    const m = matchById(db, e.match_id);
    if (!m || m.status !== 'FINISHED' || m.home_goals == null || m.away_goals == null) continue;
    const markets = marketDefMap(db);
    const marketEntry = [...markets.values()].find((d) => d.id === e.market_id);
    if (!marketEntry) continue;
    const won = settleLogic(marketEntry.code, marketEntry.line, e.selection, m.home_goals, m.away_goals);
    if (won == null) continue;
    const pnl = won ? e.stake * (e.odds_at_entry - 1) : -e.stake;
    const close = closingPrice(db, e.match_id, e.market_id, e.selection);
    settlePaperEntry(db, e.id, won ? 'WON' : 'LOST', Math.round(pnl * 100) / 100, close);
    settled++;
  }
  return settled;
}

function settleLogic(
  code: string,
  line: number | null,
  selection: string,
  hg: number,
  ag: number,
): boolean | null {
  if (code === 'ONE_X_TWO') {
    return selection === 'HOME' ? hg > ag : selection === 'DRAW' ? hg === ag : ag > hg;
  }
  if (code === 'OU_GOALS' && line != null) {
    return selection === 'OVER' ? hg + ag > line : hg + ag < line;
  }
  if (code === 'BTTS') {
    const both = hg > 0 && ag > 0;
    return selection === 'YES' ? both : !both;
  }
  if (code === 'DOUBLE_CHANCE') {
    if (selection === 'HOME_DRAW') return hg >= ag;
    if (selection === 'AWAY_DRAW') return ag >= hg;
    if (selection === 'HOME_AWAY') return hg !== ag;
  }
  if (code === 'DRAW_NO_BET') {
    if (hg === ag) return null; // push → void in V1 ledger (stake returned)
    return selection === 'HOME' ? hg > ag : ag > hg;
  }
  return null;
}

export interface PortfolioReport {
  initial: number;
  current: number;
  openExposure: number;
  entries: PaperEntryRow[];
  metrics: BettingMetrics;
  openCount: number;
}

export function portfolioReport(db: Db): PortfolioReport {
  settleDueEntries(db);
  const initial = initialBankroll(db);
  const entries = listPaperEntries(db);
  const settled: SettledBet[] = entries
    .filter((e) => e.result != null && e.pnl != null)
    .map((e) => ({
      entryOdds: e.odds_at_entry,
      stake: e.stake,
      pnl: e.pnl!,
      won: e.result === 'WON',
      settledAt: e.settled_at ?? e.entered_at,
      closingOdds: e.closing_odds,
    }));
  const metrics = computeBettingMetrics(settled, initial);
  const open = entries.filter((e) => e.result == null);
  const openExposure = open.reduce((a, e) => a + e.stake, 0);
  return {
    initial,
    current: initial + metrics.totalPnl,
    openExposure,
    entries,
    metrics,
    openCount: open.length,
  };
}

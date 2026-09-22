/**
 * Backtester.
 *
 * It deliberately reuses `evaluate` and `openPosition`/`closePosition` rather
 * than reimplementing them, so the numbers you see in a backtest come from the
 * exact same fill, fee and sizing code the live agent runs. A backtest that
 * reimplemented the logic would be a second source of truth, and the two always
 * end up disagreeing.
 *
 * Bar ordering per iteration:
 *   1. bracket exits on the bar's range (stop checked before target — we
 *      cannot know the intra-bar order, so assume the worse one),
 *   2. signal from the bar's CLOSE,
 *   3. entry at the next bar's open.
 * Entering on the close of the bar that generated the signal would be look-ahead
 * bias, so we do not.
 */

import type { BacktestResult, Candle, RiskConfig, StrategyConfig } from './types';
import { emptyPortfolio, type Portfolio, type Trade } from './types';
import { evaluate, positionSize } from './strategy';
import {
  checkExits,
  closePosition,
  equityOf,
  maxDrawdownPct,
  openPosition,
  sharpeRatio,
  advancePosition,
  winStats,
} from './engine';
import { BARS_PER_YEAR } from './data/markets';

export interface BacktestOptions {
  marketId: string;
  timeframe: keyof typeof BARS_PER_YEAR;
  strategy: StrategyConfig;
  risk: RiskConfig;
  /** Simulated clock start, so results are reproducible rather than wall-clock bound. */
  epoch?: number;
}

export function runBacktest(candles: Candle[], opts: BacktestOptions): BacktestResult {
  const { marketId, timeframe, strategy, risk } = opts;
  const fees = { feeBps: risk.feeBps, slippageBps: risk.slippageBps };

  let portfolio: Portfolio = emptyPortfolio(risk.startingCash, opts.epoch ?? 0);
  const curve: { t: number; equity: number }[] = [];
  const trades: Trade[] = [];

  let seed = 0;
  let lastExitIndex = -Infinity;
  let entryBarIndex = 0;

  const warmup =
    Math.max(
      strategy.slowPeriod,
      strategy.rsiPeriod,
      strategy.atrPeriod,
      strategy.useTrendFilter ? strategy.trendPeriod : 0,
    ) + 2;

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];
    const position = portfolio.positions[marketId];

    // 1. Bracket exits against this bar's range.
    if (position) {
      const trailed = advancePosition(position, bar, atrAt(candles, i, strategy.atrPeriod), {
        useTrailingStop: strategy.useTrailingStop,
        atrStopMultiple: strategy.atrStopMultiple,
      });
      portfolio = {
        ...portfolio,
        positions: { ...portfolio.positions, [marketId]: trailed },
      };

      const exit = checkExits(trailed, bar);
      if (exit) {
        const result = closePosition(
          portfolio,
          {
            marketId,
            price: exit.price,
            reason: exit.exit,
            time: bar.t,
            barsHeld: i - entryBarIndex,
            idSeed: seed++,
          },
          fees,
        );
        if ('error' in result) throw new Error(result.error);
        portfolio = result.portfolio;
        trades.push(result.trade!);
        lastExitIndex = i;
      }
    }

    // 2. Signal from this bar's close.
    const hasPosition = Boolean(portfolio.positions[marketId]);
    const decision = evaluate(candles.slice(0, i + 1), strategy, {
      index: i,
      hasOpenPosition: hasPosition,
      barsSinceExit: i - lastExitIndex,
    });

    // 3. Act at the NEXT bar's open — never the bar that produced the signal.
    const next = candles[i + 1];

    if (decision.action === 'CLOSE' && hasPosition && next) {
      const result = closePosition(
        portfolio,
        {
          marketId,
          price: next.o,
          reason: 'signal',
          time: next.t,
          barsHeld: i + 1 - entryBarIndex,
          idSeed: seed++,
        },
        fees,
      );
      if ('error' in result) throw new Error(result.error);
      portfolio = result.portfolio;
      trades.push(result.trade!);
      lastExitIndex = i + 1;
    } else if (decision.action === 'OPEN_LONG' && !hasPosition && next) {
      const equity = equityOf(portfolio, { [marketId]: next.o });
      const size = positionSize({
        equity,
        price: next.o,
        stopLoss: decision.stopLoss ?? next.o * 0.98,
        riskPct: strategy.riskPerTradePct,
        maxPositionPct: strategy.maxPositionPct,
        availableCash: portfolio.cash,
        feeBps: risk.feeBps,
      });

      if (size.qty > 0) {
        const result = openPosition(
          portfolio,
          {
            marketId,
            price: next.o,
            qty: size.qty,
            stopLoss: decision.stopLoss ?? next.o * 0.98,
            takeProfit: decision.takeProfit ?? next.o * 1.05,
            time: next.t,
            idSeed: seed++,
          },
          fees,
        );
        if (!('error' in result)) {
          portfolio = result.portfolio;
          entryBarIndex = i + 1;
        }
      }
    }

    curve.push({ t: bar.t, equity: equityOf(portfolio, { [marketId]: bar.c }) });
  }

  // Close anything still open at the last close so stats cover every position.
  const lastBar = candles[candles.length - 1];
  const open = portfolio.positions[marketId];
  if (open && lastBar) {
    const result = closePosition(
      portfolio,
      {
        marketId,
        price: lastBar.c,
        reason: 'manual',
        time: lastBar.t,
        barsHeld: candles.length - 1 - entryBarIndex,
        idSeed: seed++,
      },
      fees,
    );
    if (!('error' in result)) {
      portfolio = result.portfolio;
      trades.push(result.trade!);
      curve[curve.length - 1] = { t: lastBar.t, equity: portfolio.cash };
    }
  }

  const equitySeries = curve.map((p) => p.equity);
  const stats = winStats(trades);
  const startEquity = risk.startingCash;
  const endEquity = equitySeries.length ? equitySeries[equitySeries.length - 1] : startEquity;
  const first = candles[0]?.c ?? 0;
  const last = lastBar?.c ?? 0;

  return {
    equityCurve: curve,
    trades,
    startEquity,
    endEquity,
    totalReturnPct: ((endEquity - startEquity) / startEquity) * 100,
    maxDrawdownPct: maxDrawdownPct(equitySeries),
    winRatePct: stats.winRatePct,
    profitFactor: stats.profitFactor,
    sharpe: sharpeRatio(equitySeries, BARS_PER_YEAR[timeframe]),
    tradeCount: trades.length,
    avgBarsHeld: stats.avgBarsHeld,
    buyHoldReturnPct: first > 0 ? ((last - first) / first) * 100 : 0,
    bars: candles.length,
  };
}

/** ATR of bar `i`, recomputed on the trailing window only. */
function atrAt(candles: Candle[], i: number, period: number): number {
  if (i < period) return NaN;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const prev = candles[j - 1];
    const cur = candles[j];
    sum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  return sum / period;
}

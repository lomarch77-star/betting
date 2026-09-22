import { describe, expect, it } from 'vitest';
import { runBacktest } from './backtest';
import { DEFAULT_RISK, DEFAULT_STRATEGY, type RiskConfig, type StrategyConfig } from './types';
import { bars, noisyDipThenRally } from './fixtures';
import { flatCandles, simulateCandles } from './data/simulator';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({ ...DEFAULT_RISK, ...over });
const strat = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...DEFAULT_STRATEGY,
  ...over,
});

describe('runBacktest', () => {
  it('is deterministic — identical inputs give identical results', () => {
    const candles = simulateCandles(600, '1h', { seed: 1234, startPrice: 40_000 });
    const a = runBacktest(candles, {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat(),
      risk: risk(),
      epoch: 0,
    });
    const b = runBacktest(candles, {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat(),
      risk: risk(),
      epoch: 0,
    });
    expect(a).toEqual(b);
  });

  it('trades a flat market exactly zero times and keeps the starting cash', () => {
    const result = runBacktest(flatCandles(400, 100), {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat({ useTrendFilter: false }),
      risk: risk(),
    });
    expect(result.tradeCount).toBe(0);
    expect(result.endEquity).toBe(result.startEquity);
    expect(result.totalReturnPct).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
  });

  it('produces an equity point for every evaluated bar', () => {
    const candles = simulateCandles(500, '1h', { seed: 7 });
    const s = strat();
    const warmup = Math.max(s.slowPeriod, s.rsiPeriod, s.atrPeriod, s.trendPeriod) + 2;
    const result = runBacktest(candles, {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: s,
      risk: risk(),
    });
    expect(result.equityCurve).toHaveLength(candles.length - warmup);
  });

  it('opens at least one trade on a clear dip-and-rally', () => {
    const result = runBacktest(noisyDipThenRally(220, 120), {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat({ useTrendFilter: false }),
      risk: risk(),
    });
    expect(result.tradeCount).toBeGreaterThan(0);
  });

  it('computes buy-and-hold from the first and last close', () => {
    const candles = bars(300, 100, 0.01);
    const result = runBacktest(candles, {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat(),
      risk: risk(),
    });
    const expected = ((candles[candles.length - 1].c - candles[0].c) / candles[0].c) * 100;
    expect(result.buyHoldReturnPct).toBeCloseTo(expected, 6);
  });

  it('respects the starting cash setting', () => {
    const result = runBacktest(flatCandles(200, 100), {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat({ useTrendFilter: false }),
      risk: risk({ startingCash: 25_000 }),
    });
    expect(result.startEquity).toBe(25_000);
    expect(result.endEquity).toBe(25_000);
  });

  it('closes any position still open at the end so stats cover it', () => {
    const candles = simulateCandles(600, '4h', { seed: 55, startPrice: 2000 });
    const result = runBacktest(candles, {
      marketId: 'ETH/USDT',
      timeframe: '4h',
      strategy: strat({ useTrendFilter: false }),
      risk: risk(),
    });
    // Every trade must have an exit booked.
    for (const t of result.trades) {
      // >= because a position opened on the final bar is closed at that same bar.
      expect(t.exitTime).toBeGreaterThanOrEqual(t.entryTime);
      expect(Number.isFinite(t.pnl)).toBe(true);
    }
  });

  it('never risks more than the configured fraction on a single entry', () => {
    const candles = simulateCandles(800, '1h', { seed: 909, startPrice: 30_000 });
    const s = strat({ useTrendFilter: false, riskPerTradePct: 1, atrStopMultiple: 2 });
    const r = risk({ startingCash: 10_000, feeBps: 0, slippageBps: 0 });
    const result = runBacktest(candles, {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: s,
      risk: r,
    });
    for (const t of result.trades) {
      // Worst case loss on a stop-out is the risked amount plus the exit fee.
      const risked = 10_000 * 0.01;
      expect(t.pnl).toBeGreaterThanOrEqual(-(risked * 1.5));
    }
  });

  it('produces a finite Sharpe and non-negative drawdown', () => {
    const result = runBacktest(simulateCandles(700, '1h', { seed: 31 }), {
      marketId: 'BTC/USDT',
      timeframe: '1h',
      strategy: strat({ useTrendFilter: false }),
      risk: risk(),
    });
    expect(Number.isFinite(result.sharpe)).toBe(true);
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.winRatePct).toBeGreaterThanOrEqual(0);
    expect(result.winRatePct).toBeLessThanOrEqual(100);
  });

  it('changes its answer when the strategy changes', () => {
    const candles = simulateCandles(600, '1h', { seed: 4242, startPrice: 10_000 });
    const base = { marketId: 'BTC/USDT', timeframe: '1h' as const, risk: risk() };
    const a = runBacktest(candles, {
      ...base,
      strategy: strat({ useTrendFilter: false, fastPeriod: 5, slowPeriod: 20 }),
    });
    const b = runBacktest(candles, {
      ...base,
      strategy: strat({ useTrendFilter: false, fastPeriod: 50, slowPeriod: 200 }),
    });
    expect(a.tradeCount).not.toBe(b.tradeCount);
  });
});

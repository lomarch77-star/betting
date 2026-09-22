import { describe, expect, it } from 'vitest';
import { computeSeries, evaluate, positionSize, roundToLot } from './strategy';
import { DEFAULT_STRATEGY, type StrategyConfig } from './types';
import { bars, noisyDipThenRally, firstCrossAbove, firstCrossBelow } from './fixtures';
import { flatCandles } from './data/simulator';

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...DEFAULT_STRATEGY,
  ...over,
});

describe('evaluate — guards', () => {
  it('refuses to decide without enough history', () => {
    const d = evaluate(bars(10, 100, 0.001), cfg());
    expect(d.action).toBe('HOLD');
    expect(d.checks[0].id).toBe('data');
    expect(d.checks[0].pass).toBe(false);
    expect(d.reason).toMatch(/warm up/);
  });

  it('refuses to size a position on a frozen market (ATR = 0)', () => {
    const d = evaluate(flatCandles(200, 100), cfg({ useTrendFilter: false }));
    expect(d.action).toBe('HOLD');
    expect(d.reason).toMatch(/ATR is zero/);
  });

  it('evaluates the last CLOSED bar, not the forming one', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    expect(k).toBeGreaterThan(0);

    // With the cross at length-2 the default index must find it.
    const d = evaluate(series.slice(0, k + 2), cfg({ useTrendFilter: false }));
    expect(d.indicators.price).toBeCloseTo(series[k].c, 6);
  });
});

describe('evaluate — entries', () => {
  it('opens a long when every enabled entry rule passes', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const d = evaluate(series, cfg({ useTrendFilter: false }), { index: k });
    expect(d.action).toBe('OPEN_LONG');
    expect(d.checks.filter((c) => c.id === 'crossover')[0].pass).toBe(true);
    expect(d.stopLoss).toBeLessThan(d.indicators.price);
    expect(d.takeProfit).toBeGreaterThan(d.indicators.price);
  });

  it('does not enter on a bar that is merely bullish without a fresh cross', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const d = evaluate(series, cfg({ useTrendFilter: false }), { index: k + 5 });
    expect(d.action).toBe('HOLD');
    expect(d.reason).toMatch(/crossover/);
  });

  it('never enters during a sustained downtrend', () => {
    const series = bars(300, 100, -0.005);
    for (let i = 60; i < series.length - 1; i++) {
      expect(evaluate(series, cfg({ useTrendFilter: false }), { index: i }).action).toBe('HOLD');
    }
  });

  it('is blocked by the RSI filter when momentum is overbought', () => {
    const series = noisyDipThenRally(220, 60, 100, -0.004, 0.012, 0.012);
    const k = firstCrossAbove(series);
    const filtered = evaluate(series, cfg({ useTrendFilter: false, rsiOverbought: 40 }), {
      index: k,
    });
    const unfiltered = evaluate(series, cfg({ useTrendFilter: false, useRsiFilter: false }), {
      index: k,
    });
    const momentum = filtered.checks.find((c) => c.id === 'momentum')!;
    expect(momentum.pass).toBe(false);
    expect(filtered.action).toBe('HOLD');
    expect(unfiltered.action).toBe('OPEN_LONG');
  });

  it('is blocked by the trend filter when price is below the long EMA', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const d = evaluate(series, cfg({ useTrendFilter: true }), { index: k });
    const trend = d.checks.find((c) => c.id === 'trend')!;
    expect(trend.pass).toBe(false);
    expect(d.action).toBe('HOLD');
  });

  it('marks a disabled filter as not-applicable rather than passed', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const d = evaluate(series, cfg({ useTrendFilter: false, useRsiFilter: false }), { index: k });
    expect(d.checks.find((c) => c.id === 'trend')!.pass).toBeNull();
    expect(d.checks.find((c) => c.id === 'momentum')!.pass).toBeNull();
  });

  it('respects the post-exit cooldown', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const blocked = evaluate(series, cfg({ useTrendFilter: false, cooldownBars: 5 }), {
      index: k,
      barsSinceExit: 2,
    });
    const allowed = evaluate(series, cfg({ useTrendFilter: false, cooldownBars: 5 }), {
      index: k,
      barsSinceExit: 5,
    });
    expect(blocked.action).toBe('HOLD');
    expect(blocked.checks.find((c) => c.id === 'cooldown')!.pass).toBe(false);
    expect(allowed.action).toBe('OPEN_LONG');
  });
});

describe('evaluate — exits', () => {
  it('closes on a bearish cross while long', () => {
    const series = [...noisyDipThenRally(220, 60), ...bars(80, 100, -0.01)];
    const k = firstCrossBelow(series);
    expect(k).toBeGreaterThan(0);
    const d = evaluate(series, cfg({ useTrendFilter: false }), {
      index: k,
      hasOpenPosition: true,
    });
    expect(d.action).toBe('CLOSE');
    expect(d.reason).toMatch(/closing the position/i);
  });

  it('holds through an intact uptrend while long', () => {
    const series = bars(200, 100, 0.004);
    const d = evaluate(series, cfg({ useTrendFilter: false }), {
      index: series.length - 2,
      hasOpenPosition: true,
    });
    expect(d.action).toBe('HOLD');
    expect(d.reason).toMatch(/holding/i);
  });

  it('never stacks a second entry while already long', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const d = evaluate(series, cfg({ useTrendFilter: false }), {
      index: k,
      hasOpenPosition: true,
    });
    expect(d.action).not.toBe('OPEN_LONG');
    expect(d.checks.find((c) => c.id === 'position')!.pass).toBe(false);
  });
});

describe('evaluate — brackets', () => {
  it('sizes the stop and target from ATR multiples', () => {
    const series = noisyDipThenRally();
    const k = firstCrossAbove(series);
    const c = cfg({ useTrendFilter: false, atrStopMultiple: 2, atrTargetMultiple: 4 });
    const d = evaluate(series, c, { index: k });
    const atr = d.indicators.atr;
    expect(atr).toBeGreaterThan(0);
    expect(d.stopLoss).toBeCloseTo(d.indicators.price - atr * 2, 6);
    expect(d.takeProfit).toBeCloseTo(d.indicators.price + atr * 4, 6);
  });
});

describe('positionSize', () => {
  it('risks the configured fraction of equity over the stop distance', () => {
    const s = positionSize({
      equity: 10_000,
      price: 100,
      stopLoss: 90,
      riskPct: 1,
      maxPositionPct: 25,
      availableCash: 10_000,
      feeBps: 10,
    });
    expect(s.riskAmount).toBe(100);
    expect(s.qty).toBeCloseTo(10, 6);
    expect(s.notional).toBeCloseTo(1000, 6);
    expect(s.cappedBy).toBe('risk');
  });

  it('caps notional at the max position share', () => {
    const s = positionSize({
      equity: 10_000,
      price: 100,
      stopLoss: 99,
      riskPct: 10,
      maxPositionPct: 25,
      availableCash: 10_000,
      feeBps: 0,
    });
    expect(s.cappedBy).toBe('max position');
    expect(s.notional).toBeCloseTo(2500, 6);
  });

  it('never sizes beyond available cash, including the fee', () => {
    const s = positionSize({
      equity: 100_000,
      price: 100,
      stopLoss: 90,
      riskPct: 1,
      maxPositionPct: 100,
      availableCash: 500,
      feeBps: 10,
    });
    expect(s.cappedBy).toBe('cash');
    expect(s.qty * 100 * 1.001).toBeCloseTo(500, 6);
  });

  it('returns zero when the stop is above the entry', () => {
    expect(
      positionSize({
        equity: 10_000,
        price: 100,
        stopLoss: 110,
        riskPct: 1,
        maxPositionPct: 25,
        availableCash: 10_000,
        feeBps: 0,
      }).qty,
    ).toBe(0);
  });

  it('returns zero with no equity', () => {
    expect(
      positionSize({
        equity: 0,
        price: 100,
        stopLoss: 90,
        riskPct: 1,
        maxPositionPct: 25,
        availableCash: 1000,
        feeBps: 0,
      }).qty,
    ).toBe(0);
  });
});

describe('roundToLot', () => {
  it('rounds down, never up', () => {
    expect(roundToLot(0.123456789, 1e-4)).toBeCloseTo(0.1234, 10);
    expect(roundToLot(0.99999, 1e-3)).toBeCloseTo(0.999, 10);
  });

  it('passes through when tick is not positive', () => {
    expect(roundToLot(1.23456, 0)).toBe(1.23456);
  });
});

describe('computeSeries', () => {
  it('keeps every series aligned to the candle array', () => {
    const candles = bars(200, 100, 0.002);
    const s = computeSeries(candles, DEFAULT_STRATEGY);
    for (const arr of [s.close, s.fast, s.slow, s.trend, s.rsi, s.atr]) {
      expect(arr).toHaveLength(candles.length);
    }
    expect(s.close[199]).toBe(candles[199].c);
  });
});

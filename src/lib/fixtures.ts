/**
 * Shared fixtures.
 *
 * Rather than hand-waving a "bullish cross" into existence, these build a real
 * price series and locate the bar where the cross actually happens, so the
 * strategy/agent tests assert behaviour at a genuine signal bar.
 */

import type { Candle, Timeframe } from './types';
import { TIMEFRAME_MS } from './types';
import { crossedAbove, crossedBelow, ema } from './indicators';
import { mulberry32 } from './data/simulator';
import { DEFAULT_STRATEGY } from './types';

export function bars(
  count: number,
  startPrice: number,
  perBarPct: number,
  timeframe: Timeframe = '1h',
  wickPct = 0.002,
): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const start = 1_700_000_000_000;
  const out: Candle[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = Math.max(o * (1 + perBarPct), 1e-6);
    const wick = o * wickPct;
    out.push({
      t: start + i * step,
      o,
      h: Math.max(o, c) + wick,
      l: Math.max(Math.min(o, c) - wick, 1e-6),
      c,
      v: 1000,
    });
    p = c;
  }
  return out;
}

/** Decline, then rally — the classic shape that produces one bullish cross. */
export function dipThenRally(
  declineBars = 200,
  rallyBars = 60,
  startPrice = 100,
  declinePct = -0.004,
  rallyPct = 0.006,
  timeframe: Timeframe = '1h',
): Candle[] {
  const down = bars(declineBars, startPrice, declinePct, timeframe);
  const lastDown = down[down.length - 1].c;
  const up = bars(rallyBars, lastDown, rallyPct, timeframe, 0.002);
  const step = TIMEFRAME_MS[timeframe];
  const shifted = up.map((c, i) => ({ ...c, t: 1_700_000_000_000 + (declineBars + i) * step }));
  return [...down, ...shifted];
}

/**
 * A noisy random walk. `driftPct` is the mean per-bar return and `noisePct` the
 * half-width of a uniform shock. Noise matters: a *relentless* rally pins
 * RSI at 100, and the agent is then right to refuse the entry as overbought —
 * which makes it a useless fixture for testing entries. Real markets pull back.
 */
export function noisyWalk(
  count: number,
  startPrice: number,
  driftPct: number,
  noisePct: number,
  seed: number,
  timeframe: Timeframe = '1h',
): Candle[] {
  const rand = mulberry32(seed);
  const step = TIMEFRAME_MS[timeframe];
  const start = 1_700_000_000_000;
  const out: Candle[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const shock = (rand() * 2 - 1) * noisePct;
    const c = Math.max(o * (1 + driftPct + shock), 1e-6);
    const wick = o * noisePct * 0.5;
    out.push({
      t: start + i * step,
      o,
      h: Math.max(o, c) + wick,
      l: Math.max(Math.min(o, c) - wick, 1e-6),
      c,
      v: 1000 + rand() * 500,
    });
    p = c;
  }
  return out;
}

/**
 * A realistic dip-then-recovery: a noisy downtrend followed by a noisy rally.
 * With the default periods this produces exactly one bullish EMA cross at a
 * point where RSI is elevated but not overbought.
 */
export function noisyDipThenRally(
  declineBars = 220,
  rallyBars = 40,
  startPrice = 100,
  declinePct = -0.004,
  rallyPct = 0.006,
  noisePct = 0.008,
  seed = 20240,
  timeframe: Timeframe = '1h',
): Candle[] {
  const down = noisyWalk(declineBars, startPrice, declinePct, noisePct, seed, timeframe);
  const last = down[down.length - 1].c;
  const up = noisyWalk(rallyBars, last, rallyPct, noisePct, seed + 1, timeframe);
  const step = TIMEFRAME_MS[timeframe];
  return [
    ...down,
    ...up.map((c, i) => ({
      ...c,
      t: 1_700_000_000_000 + (declineBars + i) * step,
    })),
  ];
}

/** Index of the first bar where EMA(fast) crosses above EMA(slow). */
export function firstCrossAbove(
  candles: Candle[],
  fastPeriod = DEFAULT_STRATEGY.fastPeriod,
  slowPeriod = DEFAULT_STRATEGY.slowPeriod,
): number {
  const close = candles.map((c) => c.c);
  const f = ema(close, fastPeriod);
  const s = ema(close, slowPeriod);
  for (let i = 1; i < candles.length; i++) {
    if (crossedAbove(f, s, i)) return i;
  }
  return -1;
}

/** Index of the first bar where EMA(fast) crosses below EMA(slow). */
export function firstCrossBelow(
  candles: Candle[],
  fastPeriod = DEFAULT_STRATEGY.fastPeriod,
  slowPeriod = DEFAULT_STRATEGY.slowPeriod,
): number {
  const close = candles.map((c) => c.c);
  const f = ema(close, fastPeriod);
  const s = ema(close, slowPeriod);
  for (let i = 1; i < candles.length; i++) {
    if (crossedBelow(f, s, i)) return i;
  }
  return -1;
}

/** Truncates a series so the cross sits exactly at `candles.length - 2`. */
export function seriesWithCrossAtLastClosedBar(candles: Candle[], crossIndex: number): Candle[] {
  return candles.slice(0, crossIndex + 2);
}

/**
 * Deterministic, seeded market simulator.
 *
 * Two jobs:
 *  1. Keeps the app fully usable with no network at all (the whole point of a
 *     local-first phone app).
 *  2. Gives the backtester a reproducible series, so a run today and a run next
 *     week produce byte-identical results.
 *
 * The generator is geometric Brownian motion with occasional volatility
 * clusters, which is crude but produces realistic-looking trends, ranges and
 * stop-outs — enough to exercise every rule in the strategy.
 */

import type { Candle, Timeframe } from '../types';
import { TIMEFRAME_MS } from '../types';

/** mulberry32 — small, fast, and identical on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash so a market id always gets the same series. */
export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SimOptions {
  seed?: number;
  startPrice?: number;
  /** Annualised drift, e.g. 0.15 for +15%/yr. */
  drift?: number;
  /** Annualised volatility, e.g. 0.6 for a typical large-cap token. */
  vol?: number;
  /** Probability per bar of entering a volatility cluster. */
  shockProb?: number;
}

export function simulateCandles(
  count: number,
  timeframe: Timeframe,
  opts: SimOptions = {},
  endTime = Date.now(),
): Candle[] {
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[timeframe];
  const dt = 1 / barsPerYear;
  const drift = opts.drift ?? 0.12;
  const baseVol = opts.vol ?? 0.65;
  const shockProb = opts.shockProb ?? 0.02;

  const rand = mulberry32(opts.seed ?? 1337);
  const step = TIMEFRAME_MS[timeframe];
  const start = Math.floor(endTime / step) * step - (count - 1) * step;

  const candles: Candle[] = [];
  let price = opts.startPrice ?? 30_000;
  let volScale = 1;

  for (let i = 0; i < count; i++) {
    // Volatility clustering: shocks decay over a few bars.
    if (rand() < shockProb) volScale = 1.8 + rand() * 2.2;
    volScale = Math.max(1, volScale * 0.94);

    const sigma = baseVol * volScale;
    // Box-Muller for a normal draw.
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const ret = (drift - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z;
    const open = price;
    const close = Math.max(open * Math.exp(ret), 1e-6);

    // Wick size scales with realised volatility.
    const range = Math.abs(close - open) + open * sigma * Math.sqrt(dt) * (0.4 + rand());
    const high = Math.max(open, close) + range * rand();
    const low = Math.max(Math.min(open, close) - range * rand(), 1e-6);
    const volume = (500 + rand() * 1500) * volScale;

    candles.push({ t: start + i * step, o: open, h: high, l: low, c: close, v: volume });
    price = close;
  }
  return candles;
}

/** A flat, featureless series — the degenerate case a strategy must not trade. */
export function flatCandles(count: number, price: number, timeframe: Timeframe = '1h'): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const start = Math.floor(Date.now() / step) * step - (count - 1) * step;
  return Array.from({ length: count }, (_, i) => ({
    t: start + i * step,
    o: price,
    h: price,
    l: price,
    c: price,
    v: 0,
  }));
}

/** Alternating up/down bars of equal size — no net trend, no cross. */
export function sawCandles(
  count: number,
  price: number,
  stepPct = 0.01,
  timeframe: Timeframe = '1h',
): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const start = Math.floor(Date.now() / step) * step - (count - 1) * step;
  const out: Candle[] = [];
  let p = price;
  for (let i = 0; i < count; i++) {
    const o = p;
    const dir = i % 2 === 0 ? 1 : -1;
    const c = o * (1 + dir * stepPct);
    out.push({ t: start + i * step, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 });
    p = c;
  }
  return out;
}

/** Monotonic uptrend — should produce exactly one bullish cross. */
export function trendCandles(
  count: number,
  startPrice: number,
  perBarPct: number,
  timeframe: Timeframe = '1h',
): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const start = Math.floor(Date.now() / step) * step - (count - 1) * step;
  const out: Candle[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o * (1 + perBarPct);
    out.push({ t: start + i * step, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 });
    p = c;
  }
  return out;
}

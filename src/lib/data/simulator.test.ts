import { describe, expect, it } from 'vitest';
import {
  mulberry32,
  hashSeed,
  simulateCandles,
  flatCandles,
  trendCandles,
  sawCandles,
} from './simulator';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  it('differs across seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays inside [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and order-sensitive', () => {
    expect(hashSeed('BTC/USDT:1h')).toBe(hashSeed('BTC/USDT:1h'));
    expect(hashSeed('BTC/USDT:1h')).not.toBe(hashSeed('BTC/USDT:4h'));
  });
});

describe('simulateCandles', () => {
  it('produces the same series for the same seed and length', () => {
    const a = simulateCandles(200, '1h', { seed: 99, startPrice: 50_000 });
    const b = simulateCandles(200, '1h', { seed: 99, startPrice: 50_000 });
    expect(a).toEqual(b);
  });

  it('changes when the seed changes', () => {
    const a = simulateCandles(200, '1h', { seed: 1 });
    const b = simulateCandles(200, '1h', { seed: 2 });
    expect(a[100].c).not.toBe(b[100].c);
  });

  it('emits well-formed OHLCV bars in time order', () => {
    const cs = simulateCandles(500, '15m', { seed: 5 });
    expect(cs).toHaveLength(500);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      expect(c.c).toBeGreaterThan(0);
      expect(c.v).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(c.t).toBeGreaterThan(cs[i - 1].t);
      if (i > 0) expect(c.t - cs[i - 1].t).toBe(15 * 60_000);
    }
  });

  it('bars are contiguous and aligned to the timeframe', () => {
    const cs = simulateCandles(50, '4h', { seed: 3 });
    expect(cs[1].t - cs[0].t).toBe(4 * 3_600_000);
  });

  it('drifts upward with a positive drift setting', () => {
    const cs = simulateCandles(2000, '1d', { seed: 11, startPrice: 100, drift: 1.5, vol: 0.2 });
    expect(cs[cs.length - 1].c).toBeGreaterThan(cs[0].o);
  });
});

describe('synthetic fixtures', () => {
  it('flatCandles has no range at all', () => {
    for (const c of flatCandles(30, 100)) {
      expect(c.h).toBe(c.l);
      expect(c.c).toBe(100);
      expect(c.v).toBe(0);
    }
  });

  it('trendCandles is monotonic', () => {
    const cs = trendCandles(40, 100, 0.01);
    for (let i = 1; i < cs.length; i++) expect(cs[i].c).toBeGreaterThan(cs[i - 1].c);
  });

  it('sawCandles alternates direction every bar', () => {
    const cs = sawCandles(40, 100, 0.01);
    for (let i = 1; i < cs.length; i++) {
      const dir = cs[i].c > cs[i].o ? 1 : -1;
      const expected = i % 2 === 0 ? 1 : -1;
      expect(dir).toBe(expected);
    }
  });

  it('sawCandles drifts down because percentage moves compound', () => {
    // A +1% bar followed by a -1% bar nets 0.9999x, so 20 pairs end at
    // 100 * 0.9999^20 ~= 99.80 — not back at 100.
    const cs = sawCandles(40, 100, 0.01);
    const expected = 100 * 0.9999 ** 20;
    expect(cs[cs.length - 1].c).toBeCloseTo(expected, 6);
    expect(cs[cs.length - 1].c).toBeLessThan(100);
  });
});

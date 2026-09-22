import { describe, expect, it } from 'vitest';
import {
  atr,
  bollinger,
  crossedAbove,
  crossedBelow,
  ema,
  macd,
  rsi,
  slope,
  sma,
  trueRange,
  lastDefined,
  annualisedVolatility,
} from './indicators';

const close = (n: number) => n.toFixed(4);

describe('sma', () => {
  it('pads the warm-up region with NaN and averages the rest', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it('returns all NaN for a non-positive period', () => {
    expect(sma([1, 2, 3], 0)).toEqual([NaN, NaN, NaN]);
  });

  it('handles a period longer than the series', () => {
    expect(sma([1, 2], 5)).toEqual([NaN, NaN]);
  });
});

describe('ema', () => {
  it('seeds with the SMA then applies the multiplier', () => {
    // seed = (2+4+6)/3 = 4; k = 0.5; 8*.5+4*.5 = 6; 10*.5+6*.5 = 8
    const out = ema([2, 4, 6, 8, 10], 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(4);
    expect(out[3]).toBe(6);
    expect(out[4]).toBe(8);
  });

  it('tracks a constant series exactly', () => {
    const out = ema(new Array(30).fill(7), 10);
    expect(out[29]).toBeCloseTo(7, 10);
  });

  it('returns all NaN when the series is shorter than the period', () => {
    expect(ema([1, 2, 3], 10).every(Number.isNaN)).toBe(true);
  });
});

describe('rsi', () => {
  it('is exactly 100 on a strictly rising series', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14)[29]).toBe(100);
  });

  it('is exactly 0 on a strictly falling series', () => {
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(down, 14)[29]).toBe(0);
  });

  it('is neutral on a flat series', () => {
    expect(rsi(new Array(30).fill(50), 14)[29]).toBe(50);
  });

  it('matches a hand-computed Wilder value', () => {
    // period 3 over [44, 44.34, 44.09, 44.15, 43.61]
    const out = rsi([44, 44.34, 44.09, 44.15, 43.61], 3);
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeCloseTo(61.5385, 3);
    expect(out[4]).toBeCloseTo(27.3972, 3);
  });

  it('never leaves the 0-100 band', () => {
    const series = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 40 + i * 0.1);
    for (const v of rsi(series, 14)) {
      if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
      if (!Number.isNaN(v)) expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('trueRange / atr', () => {
  it('accounts for gaps through the previous close', () => {
    const tr = trueRange([10, 12, 13], [8, 9, 10], [9, 11, 12]);
    expect(tr[0]).toBe(2); // h - l on the first bar
    expect(tr[1]).toBe(3);
    expect(tr[2]).toBe(3);
  });

  it('averages true range over the period', () => {
    const out = atr([10, 12, 13], [8, 9, 10], [9, 11, 12], 2);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(3);
  });

  it('is zero on a frozen market', () => {
    const flat = new Array(30).fill(100);
    expect(atr(flat, flat, flat, 14)[29]).toBe(0);
  });
});

describe('macd', () => {
  it('is zero on a constant series', () => {
    const { macd: line, histogram } = macd(new Array(80).fill(10));
    expect(close(line[79])).toBe(close(0));
    expect(close(histogram[79])).toBe(close(0));
  });

  it('goes positive on a sustained uptrend', () => {
    const up = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(i * 0.01));
    expect(macd(up).macd[119]).toBeGreaterThan(0);
  });

  it('is NaN before the slow EMA is defined', () => {
    const out = macd(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(out.macd[10]).toBeNaN();
    expect(out.macd[25]).not.toBeNaN();
  });
});

describe('bollinger', () => {
  it('computes the hand-checked bands for a 2-period window', () => {
    const b = bollinger([1, 2, 3], 2, 2);
    expect(b.middle).toEqual([NaN, 1.5, 2.5]);
    expect(b.upper[1]).toBeCloseTo(2.5, 10);
    expect(b.lower[1]).toBeCloseTo(0.5, 10);
    expect(b.bandwidth[1]).toBeCloseTo(4 / 3, 10);
  });

  it('collapses to zero width on a constant series', () => {
    const b = bollinger(new Array(30).fill(42), 20, 2);
    expect(b.upper[29]).toBeCloseTo(42, 10);
    expect(b.lower[29]).toBeCloseTo(42, 10);
    expect(b.bandwidth[29]).toBeCloseTo(0, 10);
  });
});

describe('slope', () => {
  it('returns the per-bar change of a straight line', () => {
    const s = slope([1, 3, 5, 7, 9], 3);
    expect(s[2]).toBeCloseTo(2, 10);
    expect(s[4]).toBeCloseTo(2, 10);
  });

  it('is zero on a flat line', () => {
    expect(slope(new Array(10).fill(5), 5)[9]).toBeCloseTo(0, 10);
  });
});

describe('annualisedVolatility', () => {
  it('is zero for a constant series', () => {
    expect(annualisedVolatility(new Array(50).fill(100), 8760)).toBe(0);
  });

  it('is NaN with fewer than two points', () => {
    expect(annualisedVolatility([100], 8760)).toBeNaN();
  });
});

describe('cross detection', () => {
  it('fires only on the exact crossing bar', () => {
    const fast = [1, 2, 3, 4];
    const slow = [3, 3, 3, 3];
    // At index 2 fast (3) merely equals slow (3) — not yet a cross.
    expect(crossedAbove(fast, slow, 2)).toBe(false);
    // At index 3 fast (4) is strictly above slow after being at-or-below it.
    expect(crossedAbove(fast, slow, 3)).toBe(true);
    expect(crossedBelow(fast, slow, 3)).toBe(false);
  });

  it('does not re-fire on the bar after a cross', () => {
    const fast = [1, 2, 4, 5];
    const slow = [3, 3, 3, 3];
    expect(crossedAbove(fast, slow, 2)).toBe(true);
    expect(crossedAbove(fast, slow, 3)).toBe(false);
  });

  it('counts a touch on the prior bar as the starting condition', () => {
    // f0 == s0 satisfies `f0 <= s0`, so a touch followed by a move up fires.
    expect(crossedAbove([3, 4], [3, 3], 1)).toBe(true);
    expect(crossedBelow([3, 2], [3, 3], 1)).toBe(true);
  });

  it('does not fire when the lines merely converge without separating', () => {
    expect(crossedAbove([1, 3], [3, 3], 1)).toBe(false);
    expect(crossedBelow([5, 3], [3, 3], 1)).toBe(false);
  });

  it('detects a downward cross', () => {
    const fast = [5, 4, 2, 1];
    const slow = [3, 3, 3, 3];
    expect(crossedBelow(fast, slow, 2)).toBe(true);
    expect(crossedAbove(fast, slow, 2)).toBe(false);
  });

  it('is false while either line is still NaN', () => {
    expect(crossedAbove([NaN, 2], [NaN, 1], 1)).toBe(false);
  });

  it('is false at index 0', () => {
    expect(crossedAbove([1], [0], 0)).toBe(false);
  });
});

describe('lastDefined', () => {
  it('skips trailing NaNs', () => {
    expect(lastDefined([1, 2, 3, NaN, NaN])).toBe(3);
  });

  it('is NaN for an all-NaN series', () => {
    expect(lastDefined([NaN, NaN])).toBeNaN();
  });
});

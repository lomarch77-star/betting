import { describe, expect, it } from 'vitest';
import { sanitiseRisk, sanitiseStrategy, RISK_BOUNDS, STRATEGY_BOUNDS } from './validate';
import { DEFAULT_RISK, DEFAULT_STRATEGY } from './types';

describe('sanitiseStrategy', () => {
  it('leaves a sensible config untouched', () => {
    expect(sanitiseStrategy(DEFAULT_STRATEGY)).toEqual(DEFAULT_STRATEGY);
  });

  it('repairs the value a cleared number input produces', () => {
    // Number('') === 0, which would make every EMA all-NaN.
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, fastPeriod: 0, slowPeriod: 0 });
    expect(s.fastPeriod).toBe(STRATEGY_BOUNDS.fastPeriod[0]);
    expect(s.slowPeriod).toBeGreaterThan(s.fastPeriod);
  });

  it('keeps slow strictly greater than fast', () => {
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, fastPeriod: 50, slowPeriod: 10 });
    expect(s.slowPeriod).toBeGreaterThan(s.fastPeriod);
  });

  it('keeps oversold strictly below overbought', () => {
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, rsiOverbought: 55, rsiOversold: 90 });
    expect(s.rsiOversold).toBeLessThan(s.rsiOverbought);
  });

  it('rejects a negative or zero ATR multiple that would invert the bracket', () => {
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, atrStopMultiple: -5 });
    expect(s.atrStopMultiple).toBe(STRATEGY_BOUNDS.atrStopMultiple[0]);
  });

  it('clamps a wildly oversized risk setting', () => {
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, riskPerTradePct: 5000 });
    expect(s.riskPerTradePct).toBe(STRATEGY_BOUNDS.riskPerTradePct[1]);
  });

  it('falls back to defaults for NaN and Infinity', () => {
    const s = sanitiseStrategy({
      ...DEFAULT_STRATEGY,
      fastPeriod: NaN,
      slowPeriod: Infinity,
      atrPeriod: NaN,
      cooldownBars: NaN,
    });
    expect(s.fastPeriod).toBe(DEFAULT_STRATEGY.fastPeriod);
    expect(Number.isFinite(s.slowPeriod)).toBe(true);
    expect(s.atrPeriod).toBe(DEFAULT_STRATEGY.atrPeriod);
    expect(s.cooldownBars).toBe(DEFAULT_STRATEGY.cooldownBars);
  });

  it('rounds fractional period lengths', () => {
    const s = sanitiseStrategy({ ...DEFAULT_STRATEGY, fastPeriod: 12.7, rsiPeriod: 14.2 });
    expect(s.fastPeriod).toBe(13);
    expect(s.rsiPeriod).toBe(14);
  });

  it('coerces truthy flags to real booleans', () => {
    const s = sanitiseStrategy({
      ...DEFAULT_STRATEGY,
      useTrendFilter: 1 as unknown as boolean,
      useRsiFilter: 0 as unknown as boolean,
    });
    expect(s.useTrendFilter).toBe(true);
    expect(s.useRsiFilter).toBe(false);
  });
});

describe('sanitiseRisk', () => {
  it('leaves a sensible config untouched', () => {
    expect(sanitiseRisk(DEFAULT_RISK)).toEqual(DEFAULT_RISK);
  });

  it('never allows zero or negative starting cash', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, startingCash: 0 }).startingCash).toBe(
      RISK_BOUNDS.startingCash[0],
    );
  });

  it('keeps at least one position slot', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, maxOpenPositions: 0 }).maxOpenPositions).toBe(1);
  });

  it('rounds the position count', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, maxOpenPositions: 3.6 }).maxOpenPositions).toBe(4);
  });

  it('refuses a 100% drawdown limit, which could never trigger meaningfully', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, maxDrawdownPct: 100 }).maxDrawdownPct).toBe(99);
  });

  it('caps an absurd fee', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, feeBps: 99_999 }).feeBps).toBe(RISK_BOUNDS.feeBps[1]);
  });

  it('falls back for NaN', () => {
    expect(sanitiseRisk({ ...DEFAULT_RISK, startingCash: NaN }).startingCash).toBe(10_000);
  });
});

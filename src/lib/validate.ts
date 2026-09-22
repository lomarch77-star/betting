/**
 * Input validation.
 *
 * The settings screen feeds numbers straight from a text input, so a user can
 * transiently produce `fastPeriod: 0` (clearing the field yields `Number('') === 0`)
 * or a negative risk percentage. Those values do not throw — they quietly
 * produce all-NaN indicators, a stop above the entry, or a division by zero deep
 * in the sizing maths. Clamping at the store boundary means the engine only ever
 * sees parameters it can actually reason about.
 */

import type { RiskConfig, StrategyConfig } from './types';

const clamp = (n: number, lo: number, hi: number, fallback: number): number => {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
};

export const STRATEGY_BOUNDS = {
  fastPeriod: [2, 200],
  slowPeriod: [3, 500],
  trendPeriod: [5, 600],
  rsiPeriod: [2, 100],
  rsiOverbought: [50, 100],
  rsiOversold: [1, 49],
  atrPeriod: [2, 100],
  atrStopMultiple: [0.1, 20],
  atrTargetMultiple: [0.1, 50],
  riskPerTradePct: [0.01, 50],
  maxPositionPct: [1, 100],
  cooldownBars: [0, 1000],
} as const;

export function sanitiseStrategy(cfg: StrategyConfig): StrategyConfig {
  const b = STRATEGY_BOUNDS;
  const fastPeriod = Math.round(clamp(cfg.fastPeriod, b.fastPeriod[0], b.fastPeriod[1], 12));
  // The crossover only means something if slow is genuinely slower than fast.
  const slowPeriod = Math.max(
    Math.round(clamp(cfg.slowPeriod, b.slowPeriod[0], b.slowPeriod[1], 26)),
    fastPeriod + 1,
  );
  const rsiOverbought = clamp(cfg.rsiOverbought, b.rsiOverbought[0], b.rsiOverbought[1], 70);
  const rsiOversold = Math.min(
    clamp(cfg.rsiOversold, b.rsiOversold[0], b.rsiOversold[1], 30),
    rsiOverbought - 1,
  );

  return {
    fastPeriod,
    slowPeriod,
    trendPeriod: Math.round(clamp(cfg.trendPeriod, b.trendPeriod[0], b.trendPeriod[1], 100)),
    useTrendFilter: Boolean(cfg.useTrendFilter),
    rsiPeriod: Math.round(clamp(cfg.rsiPeriod, b.rsiPeriod[0], b.rsiPeriod[1], 14)),
    rsiOverbought,
    rsiOversold,
    useRsiFilter: Boolean(cfg.useRsiFilter),
    atrPeriod: Math.round(clamp(cfg.atrPeriod, b.atrPeriod[0], b.atrPeriod[1], 14)),
    atrStopMultiple: clamp(cfg.atrStopMultiple, b.atrStopMultiple[0], b.atrStopMultiple[1], 2),
    atrTargetMultiple: clamp(
      cfg.atrTargetMultiple,
      b.atrTargetMultiple[0],
      b.atrTargetMultiple[1],
      4,
    ),
    useTrailingStop: Boolean(cfg.useTrailingStop),
    riskPerTradePct: clamp(cfg.riskPerTradePct, b.riskPerTradePct[0], b.riskPerTradePct[1], 1),
    maxPositionPct: clamp(cfg.maxPositionPct, b.maxPositionPct[0], b.maxPositionPct[1], 25),
    cooldownBars: Math.round(clamp(cfg.cooldownBars, b.cooldownBars[0], b.cooldownBars[1], 3)),
  };
}

export const RISK_BOUNDS = {
  startingCash: [100, 1e9],
  feeBps: [0, 500],
  slippageBps: [0, 500],
  maxOpenPositions: [1, 20],
  maxDrawdownPct: [1, 99],
  maxDailyLossPct: [0.1, 99],
  maxLeverage: [1, 10],
} as const;

export function sanitiseRisk(cfg: RiskConfig): RiskConfig {
  const b = RISK_BOUNDS;
  return {
    startingCash: clamp(cfg.startingCash, b.startingCash[0], b.startingCash[1], 10_000),
    feeBps: clamp(cfg.feeBps, b.feeBps[0], b.feeBps[1], 10),
    slippageBps: clamp(cfg.slippageBps, b.slippageBps[0], b.slippageBps[1], 5),
    maxOpenPositions: Math.round(
      clamp(cfg.maxOpenPositions, b.maxOpenPositions[0], b.maxOpenPositions[1], 3),
    ),
    maxDrawdownPct: clamp(cfg.maxDrawdownPct, b.maxDrawdownPct[0], b.maxDrawdownPct[1], 20),
    maxDailyLossPct: clamp(cfg.maxDailyLossPct, b.maxDailyLossPct[0], b.maxDailyLossPct[1], 5),
    maxLeverage: clamp(cfg.maxLeverage, b.maxLeverage[0], b.maxLeverage[1], 1),
  };
}

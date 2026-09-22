/**
 * The strategy engine — the "reasoning" half of the agent.
 *
 * It is deliberately deterministic and dependency-free: given the same candles
 * and the same config it always returns the same decision. Every decision
 * carries a `checks` array recording which rules fired, which passed, and why.
 * That trace is what the Agent screen renders and what the audit log stores, so
 * a user can always answer "why did it do that?" without a black box.
 */

import type { Candle, Decision, RuleCheck, StrategyConfig } from './types';
import { atr, crossedAbove, crossedBelow, ema, rsi } from './indicators';

export interface EvaluatedSeries {
  close: number[];
  fast: number[];
  slow: number[];
  trend: number[];
  rsi: number[];
  atr: number[];
}

/** Pre-computes every indicator the strategy needs, once per candle array. */
export function computeSeries(candles: Candle[], cfg: StrategyConfig): EvaluatedSeries {
  const close = candles.map((c) => c.c);
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  return {
    close,
    fast: ema(close, cfg.fastPeriod),
    slow: ema(close, cfg.slowPeriod),
    trend: ema(close, cfg.trendPeriod),
    rsi: rsi(close, cfg.rsiPeriod),
    atr: atr(high, low, close, cfg.atrPeriod),
  };
}

export interface EvaluateOptions {
  /** Index of the bar to evaluate. Defaults to the last closed bar. */
  index?: number;
  /** True when an entry was taken on this bar already (suppresses re-entry). */
  hasOpenPosition?: boolean;
  /** Bars since the last exit, for the cooldown rule. Infinity if never traded. */
  barsSinceExit?: number;
}

/**
 * Produces the decision for a single bar.
 *
 * Entry requires ALL enabled entry rules to pass (a conjunction, not a vote) —
 * the score is reported for display and sorting but never decides on its own.
 * An exit fires on the first bearish trigger, so risk rules always win.
 */
export function evaluate(
  candles: Candle[],
  cfg: StrategyConfig,
  opts: EvaluateOptions = {},
): Decision {
  const warmup = Math.max(
    cfg.slowPeriod,
    cfg.fastPeriod,
    cfg.rsiPeriod,
    cfg.atrPeriod,
    cfg.useTrendFilter ? cfg.trendPeriod : 0,
  );

  const fail = (message: string): Decision => ({
    action: 'HOLD',
    score: 0,
    checks: [
      {
        id: 'data',
        label: 'Enough history',
        pass: false,
        detail: message,
        weight: 0,
      },
    ],
    indicators: { fast: NaN, slow: NaN, trend: NaN, rsi: NaN, atr: NaN, price: NaN },
    reason: message,
  });

  // Evaluate the last CLOSED bar. The final element of a live feed is still
  // forming, and acting on a partial bar is the classic way a bot repaints its
  // own signals.
  const i = opts.index ?? candles.length - 2;
  if (candles.length < warmup + 2 || i < 1) {
    return fail(`Need ${warmup + 2} bars to warm up, have ${candles.length}.`);
  }

  const s = computeSeries(candles.slice(0, i + 1), cfg);
  const price = s.close[i];
  const f = s.fast[i];
  const sl = s.slow[i];
  const trend = s.trend[i];
  const r = s.rsi[i];
  const a = s.atr[i];

  if ([price, f, sl, r, a].some(Number.isNaN)) {
    return fail('Indicators are still warming up on this bar.');
  }
  if (!(a > 0)) {
    return fail('ATR is zero — market looks frozen, refusing to size a position.');
  }

  const checks: RuleCheck[] = [];
  const trendOk = !cfg.useTrendFilter || Number.isNaN(trend) || price > trend;

  checks.push({
    id: 'trend',
    label: `Trend filter (price > EMA${cfg.trendPeriod})`,
    pass: cfg.useTrendFilter ? trendOk : null,
    detail: cfg.useTrendFilter
      ? Number.isNaN(trend)
        ? 'Trend line unavailable yet — filter skipped.'
        : `${price.toFixed(2)} vs EMA${cfg.trendPeriod} ${trend.toFixed(2)} — ${trendOk ? 'above' : 'below'}`
      : 'Disabled in strategy settings.',
    weight: trendOk ? 1 : -1,
  });

  const justCrossedUp = crossedAbove(s.fast, s.slow, i);
  const justCrossedDown = crossedBelow(s.fast, s.slow, i);
  const stacked = f > sl;

  checks.push({
    id: 'crossover',
    label: `EMA${cfg.fastPeriod}/${cfg.slowPeriod} crossover`,
    pass: justCrossedUp,
    detail: justCrossedUp
      ? `Bullish cross on this bar (${f.toFixed(2)} > ${sl.toFixed(2)}).`
      : justCrossedDown
        ? `Bearish cross on this bar (${f.toFixed(2)} < ${sl.toFixed(2)}).`
        : stacked
          ? `Already bullish (${f.toFixed(2)} > ${sl.toFixed(2)}) — waiting for a fresh cross to enter.`
          : `Bearish (${f.toFixed(2)} < ${sl.toFixed(2)}).`,
    weight: justCrossedUp ? 2 : justCrossedDown ? -2 : stacked ? 1 : -1,
  });

  const rsiOk = !cfg.useRsiFilter || r < cfg.rsiOverbought;
  checks.push({
    id: 'momentum',
    label: `RSI${cfg.rsiPeriod} not overbought (< ${cfg.rsiOverbought})`,
    pass: cfg.useRsiFilter ? rsiOk : null,
    detail: cfg.useRsiFilter
      ? `RSI is ${r.toFixed(1)} — ${r < cfg.rsiOversold ? 'oversold' : r > cfg.rsiOverbought ? 'overbought, chase risk' : 'neutral'}.`
      : 'Disabled in strategy settings.',
    weight: r > cfg.rsiOverbought ? -2 : r < cfg.rsiOversold ? 1 : 0,
  });

  const stopLoss = price - a * cfg.atrStopMultiple;
  const takeProfit = price + a * cfg.atrTargetMultiple;

  // ---- Exit rules: checked first so risk always outranks entry. ----
  if (opts.hasOpenPosition) {
    checks.push({
      id: 'position',
      label: 'Position open',
      pass: false,
      detail: 'Already long this market — no stacked entries.',
      weight: 0,
    });

    const exitChecks: RuleCheck[] = [
      {
        id: 'crossover',
        label: `EMA${cfg.fastPeriod}/${cfg.slowPeriod} bearish cross`,
        pass: justCrossedDown,
        detail: justCrossedDown
          ? 'Trend rolled over — exit.'
          : `Fast ${f.toFixed(2)} still above slow ${sl.toFixed(2)}.`,
        weight: justCrossedDown ? -2 : 1,
      },
    ];
    checks.push(...exitChecks);

    const exitNow = justCrossedDown;
    const score = sum(checks);
    return {
      action: exitNow ? 'CLOSE' : 'HOLD',
      score,
      checks,
      indicators: { fast: f, slow: sl, trend, rsi: r, atr: a, price },
      stopLoss,
      takeProfit,
      reason: exitNow
        ? `Bearish EMA${cfg.fastPeriod}/${cfg.slowPeriod} cross at ${price.toFixed(2)} — closing the position.`
        : `Holding: trend intact (RSI ${r.toFixed(1)}, ATR ${a.toFixed(2)}).`,
    };
  }

  checks.push({
    id: 'cooldown',
    label: `Cooldown (${cfg.cooldownBars} bars after an exit)`,
    pass: (opts.barsSinceExit ?? Infinity) >= cfg.cooldownBars,
    detail:
      (opts.barsSinceExit ?? Infinity) >= cfg.cooldownBars
        ? 'No recent exit, or enough bars have passed.'
        : `${opts.barsSinceExit} bar(s) since last exit — waiting out the cooldown.`,
    weight: 0,
  });

  const entryRules = checks.filter((c) => c.id !== 'cooldown');
  const allPass = entryRules.every((c) => c.pass === true || c.pass === null);
  const cooldownPass = checks[checks.length - 1].pass === true;
  const score = sum(checks);

  return {
    action: allPass && cooldownPass ? 'OPEN_LONG' : 'HOLD',
    score,
    checks,
    indicators: { fast: f, slow: sl, trend, rsi: r, atr: a, price },
    stopLoss,
    takeProfit,
    reason:
      allPass && cooldownPass
        ? `All ${entryRules.filter((c) => c.pass !== null).length} entry rules passed at ${price.toFixed(2)}.`
        : `No entry: ${
            entryRules
              .filter((c) => c.pass === false)
              .map((c) => c.id)
              .join(', ') || 'cooldown active'
          }.`,
  };
}

function sum(checks: RuleCheck[]): number {
  return checks.reduce((acc, c) => acc + (c.pass === false ? 0 : c.weight), 0);
}

/**
 * Fixed-fractional sizing. Risks `riskPct` of equity on the distance to the
 * stop, then caps the notional at `maxPositionPct` of equity and at the cash
 * actually available. Returns 0 when the trade cannot be taken.
 */
export function positionSize(args: {
  equity: number;
  price: number;
  stopLoss: number;
  riskPct: number;
  maxPositionPct: number;
  availableCash: number;
  feeBps: number;
}): { qty: number; notional: number; riskAmount: number; cappedBy: string } {
  const { equity, price, stopLoss, riskPct, maxPositionPct, availableCash, feeBps } = args;
  const stopDistance = price - stopLoss;
  if (!(price > 0) || !(stopDistance > 0) || equity <= 0) {
    return { qty: 0, notional: 0, riskAmount: 0, cappedBy: 'invalid' };
  }

  const riskAmount = equity * (riskPct / 100);
  const feeRate = feeBps / 10_000;

  let qty = riskAmount / stopDistance;
  let cappedBy = 'risk';

  const capNotional = equity * (maxPositionPct / 100);
  if (qty * price > capNotional) {
    qty = capNotional / price;
    cappedBy = 'max position';
  }

  // Cash cap accounts for the fee on top of the notional.
  const cashCap = availableCash / (1 + feeRate);
  if (qty * price > cashCap) {
    qty = cashCap / price;
    cappedBy = 'cash';
  }

  if (!(qty > 0) || !Number.isFinite(qty)) {
    return { qty: 0, notional: 0, riskAmount, cappedBy: 'none' };
  }
  return { qty, notional: qty * price, riskAmount, cappedBy };
}

/** Rounds a quantity down to the exchange's lot size, never up. */
export function roundToLot(qty: number, tick: number): number {
  if (!(tick > 0)) return qty;
  return Math.floor(qty / tick + 1e-9) * tick;
}

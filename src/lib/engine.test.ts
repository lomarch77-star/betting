import { describe, expect, it } from 'vitest';
import {
  applySlippage,
  checkExits,
  closePosition,
  equityOf,
  feeFor,
  lotSizeFor,
  maxDrawdownPct,
  openPosition,
  sharpeRatio,
  unrealisedPnl,
  updateTrail,
  winStats,
} from './engine';
import { emptyPortfolio, type Position, type Portfolio, type Trade } from './types';

const NO_FEES = { feeBps: 0, slippageBps: 0 };

function longAt(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    marketId: 'BTC/USDT',
    side: 'long',
    qty: 1,
    entryPrice: 100,
    entryTime: 0,
    stopLoss: 90,
    takeProfit: 150,
    highWaterMark: 100,
    strategy: 'ema-atr',
    ...over,
  };
}

describe('feeFor / applySlippage', () => {
  it('charges basis points on notional', () => {
    expect(feeFor(10_000, 10)).toBe(10); // 10 bps = 0.1%
    expect(feeFor(10_000, 0)).toBe(0);
  });

  it('moves the fill against the taker in both directions', () => {
    expect(applySlippage(100, 'buy', 100)).toBeCloseTo(101, 10);
    expect(applySlippage(100, 'sell', 100)).toBeCloseTo(99, 10);
    expect(applySlippage(100, 'buy', 0)).toBe(100);
  });
});

describe('openPosition', () => {
  it('debits notional plus fee and records the fill', () => {
    const result = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 10, stopLoss: 90, takeProfit: 130 },
      { feeBps: 100, slippageBps: 0 },
    );
    if ('error' in result) throw new Error(result.error);
    // fill 100 * 10 = 1000 notional, 1% fee = 10
    expect(result.portfolio.cash).toBeCloseTo(10_000 - 1000 - 10, 6);
    expect(result.order.fee).toBeCloseTo(10, 6);
    expect(result.position!.entryPrice).toBe(100);
    expect(result.position!.qty).toBeCloseTo(10, 5);
  });

  it('applies buy slippage so the entry is worse than the quoted price', () => {
    const result = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      { feeBps: 0, slippageBps: 50 },
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.position!.entryPrice).toBeCloseTo(100.5, 6);
    expect(result.order.slippage).toBeCloseTo(0.5, 6);
  });

  it('rejects a stop that is not below the entry', () => {
    const r = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 105, takeProfit: 130 },
      NO_FEES,
    );
    expect('error' in r).toBe(true);
  });

  it('rejects a non-positive quantity', () => {
    const r = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 0, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    expect('error' in r).toBe(true);
  });

  it('rejects spending cash it does not have', () => {
    const r = openPosition(
      emptyPortfolio(500),
      { marketId: 'BTC/USDT', price: 100, qty: 10, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/Insufficient cash/);
  });

  it('rejects stacking a second position in the same market', () => {
    const first = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    if ('error' in first) throw new Error(first.error);
    const second = openPosition(
      first.portfolio,
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    expect('error' in second).toBe(true);
  });

  it('does not mutate the input portfolio', () => {
    const p = emptyPortfolio(10_000);
    const result = openPosition(
      p,
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    if ('error' in result) throw new Error(result.error);
    expect(p.cash).toBe(10_000);
    expect(Object.keys(p.positions)).toHaveLength(0);
    expect(result.portfolio).not.toBe(p);
  });
});

describe('closePosition', () => {
  it('credits proceeds minus fee and books the net P&L', () => {
    const opened = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    if ('error' in opened) throw new Error(opened.error);

    const closed = closePosition(
      opened.portfolio,
      { marketId: 'BTC/USDT', price: 110, reason: 'take_profit' },
      NO_FEES,
    );
    if ('error' in closed) throw new Error(closed.error);
    // 10000 - 100 (entry) + 110 (exit) = 10010 — the entry already debited the cash.
    expect(closed.portfolio.cash).toBeCloseTo(10_010, 6);
    expect(closed.trade!.pnl).toBeCloseTo(10, 6);
    expect(closed.trade!.pnlPct).toBeCloseTo(10, 6);
    expect(Object.keys(closed.portfolio.positions)).toHaveLength(0);
    expect(closed.portfolio.trades).toHaveLength(1);
  });

  it('subtracts both the entry and exit fees from P&L', () => {
    const fees = { feeBps: 100, slippageBps: 0 }; // 1%
    const opened = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      fees,
    );
    if ('error' in opened) throw new Error(opened.error);
    const closed = closePosition(
      opened.portfolio,
      { marketId: 'BTC/USDT', price: 110, reason: 'signal' },
      fees,
    );
    if ('error' in closed) throw new Error(closed.error);
    // cost 101, proceeds 108.9 -> 7.9
    expect(closed.trade!.pnl).toBeCloseTo(7.9, 6);
  });

  it('records the holding period', () => {
    const opened = openPosition(
      emptyPortfolio(10_000),
      { marketId: 'BTC/USDT', price: 100, qty: 1, stopLoss: 90, takeProfit: 130 },
      NO_FEES,
    );
    if ('error' in opened) throw new Error(opened.error);
    const closed = closePosition(
      opened.portfolio,
      { marketId: 'BTC/USDT', price: 100, reason: 'signal', barsHeld: 7 },
      NO_FEES,
    );
    if ('error' in closed) throw new Error(closed.error);
    expect(closed.trade!.barsHeld).toBe(7);
  });

  it('rejects closing something that is not open', () => {
    expect(
      'error' in
        closePosition(
          emptyPortfolio(10_000),
          { marketId: 'ETH/USDT', price: 100, reason: 'manual' },
          NO_FEES,
        ),
    ).toBe(true);
  });
});

describe('equityOf / unrealisedPnl', () => {
  it('marks open positions to market', () => {
    const p: Portfolio = {
      ...emptyPortfolio(1000),
      positions: { 'BTC/USDT': longAt({ qty: 2, entryPrice: 100 }) },
    };
    expect(equityOf(p, { 'BTC/USDT': 150 })).toBeCloseTo(1000 + 300, 6);
  });

  it('falls back to entry price when no mark is available', () => {
    const p: Portfolio = {
      ...emptyPortfolio(1000),
      positions: { 'BTC/USDT': longAt({ qty: 2, entryPrice: 100 }) },
    };
    expect(equityOf(p, {})).toBeCloseTo(1200, 6);
  });

  it('nets the exit cost out of unrealised P&L', () => {
    const pnl = unrealisedPnl(longAt({ qty: 1, entryPrice: 100 }), 110, 100, 0);
    // cost 101, proceeds 108.9
    expect(pnl).toBeCloseTo(7.9, 6);
  });
});

describe('checkExits', () => {
  it('prefers the stop when both levels sit inside the bar range', () => {
    // The bar spans the whole bracket; intra-bar order is unknowable, so the
    // pessimistic outcome is the correct one to book.
    const hit = checkExits(longAt({ stopLoss: 90, takeProfit: 110 }), { h: 120, l: 80 });
    expect(hit).toEqual({ exit: 'stop_loss', price: 90 });
  });

  it('takes profit when only the target is touched', () => {
    expect(checkExits(longAt({ stopLoss: 90, takeProfit: 110 }), { h: 112, l: 95 })).toEqual({
      exit: 'take_profit',
      price: 110,
    });
  });

  it('stops out when only the stop is touched', () => {
    expect(checkExits(longAt({ stopLoss: 90, takeProfit: 150 }), { h: 100, l: 88 })).toEqual({
      exit: 'stop_loss',
      price: 90,
    });
  });

  it('does nothing when the bar stays inside the bracket', () => {
    expect(checkExits(longAt({ stopLoss: 90, takeProfit: 150 }), { h: 120, l: 95 })).toBeNull();
  });

  it('ignores a zero take-profit', () => {
    expect(checkExits(longAt({ stopLoss: 90, takeProfit: 0 }), { h: 1e6, l: 95 })).toBeNull();
  });
});

describe('updateTrail', () => {
  it('raises the stop as the market moves up', () => {
    const t = updateTrail(longAt({ stopLoss: 90, highWaterMark: 100 }), { h: 130 }, 10, 2);
    expect(t.highWaterMark).toBe(130);
    expect(t.stopLoss).toBe(110); // 130 - 2*10
  });

  it('never lowers an existing stop', () => {
    const t = updateTrail(longAt({ stopLoss: 120, highWaterMark: 130 }), { h: 131 }, 10, 2);
    expect(t.stopLoss).toBe(120); // trailed would be 111, which is worse
  });

  it('keeps the high-water mark on a falling bar', () => {
    const t = updateTrail(longAt({ stopLoss: 90, highWaterMark: 130 }), { h: 100 }, 10, 2);
    expect(t.highWaterMark).toBe(130);
    expect(t.stopLoss).toBe(110);
  });
});

describe('lotSizeFor', () => {
  it('gets coarser for cheaper assets', () => {
    expect(lotSizeFor(50_000)).toBe(1e-5);
    expect(lotSizeFor(500)).toBe(1e-4);
    expect(lotSizeFor(50)).toBe(1e-3);
    expect(lotSizeFor(0.5)).toBe(1e-2);
  });
});

describe('winStats', () => {
  const trade = (pnl: number, barsHeld = 1): Trade => ({
    id: `t${pnl}`,
    marketId: 'BTC/USDT',
    side: 'long',
    qty: 1,
    entryPrice: 100,
    entryTime: 0,
    exitPrice: 100 + pnl,
    exitTime: 1,
    exitReason: 'signal',
    pnl,
    pnlPct: pnl,
    barsHeld,
  });

  it('computes win rate and profit factor', () => {
    const s = winStats([trade(30), trade(10), trade(-20), trade(-10)]);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRatePct).toBe(50);
    expect(s.profitFactor).toBeCloseTo(40 / 30, 6);
    expect(s.avgBarsHeld).toBe(1);
  });

  it('reports infinite profit factor with no losses but real profit', () => {
    expect(winStats([trade(5)]).profitFactor).toBe(Infinity);
  });

  it('handles the empty case without dividing by zero', () => {
    const s = winStats([]);
    expect(s.winRatePct).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(s.avgBarsHeld).toBe(0);
  });
});

describe('maxDrawdownPct', () => {
  it('measures from the running peak, not the start', () => {
    expect(maxDrawdownPct([100, 120, 60, 90])).toBeCloseTo(50, 6);
  });

  it('is zero for a monotonic curve', () => {
    expect(maxDrawdownPct([100, 110, 120])).toBe(0);
  });

  it('is zero for an empty curve', () => {
    expect(maxDrawdownPct([])).toBe(0);
  });
});

describe('sharpeRatio', () => {
  it('is zero for a flat equity curve', () => {
    expect(sharpeRatio([100, 100, 100, 100], 8760)).toBe(0);
  });

  it('is zero with fewer than two points', () => {
    expect(sharpeRatio([100], 8760)).toBe(0);
  });

  it('is positive for a steadily rising curve', () => {
    const curve = Array.from({ length: 50 }, (_, i) => 100 + i);
    expect(sharpeRatio(curve, 8760)).toBeGreaterThan(0);
  });
});

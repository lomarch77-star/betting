/**
 * Local persistence.
 *
 * Everything lives in the browser: nothing is sent anywhere except the public
 * price endpoints, and those carry no identifying data. State is versioned so a
 * schema change can migrate or discard rather than silently corrupt.
 *
 * Storage can throw (Safari private mode, full quota, blocked storage), so every
 * path degrades to an in-memory map instead of crashing the app.
 */

const KEY = 'paperdesk.state.v1';
const SCHEMA_VERSION = 1;

const memory = new Map<string, string>();

function backing(): Storage | null {
  try {
    const probe = '__paperdesk_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface PersistedState {
  version: number;
  savedAt: number;
  payload: unknown;
}

export function loadState<T>(fallback: T): T {
  const store = backing();
  const raw = store ? store.getItem(KEY) : memory.get(KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== SCHEMA_VERSION) return fallback;
    return { ...fallback, ...(parsed.payload as object) } as T;
  } catch {
    return fallback;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write — a phone can tick every few seconds. */
export function saveState(payload: unknown, debounceMs = 400): void {
  const write = () => {
    const record: PersistedState = {
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      payload,
    };
    const raw = JSON.stringify(record);
    const store = backing();
    try {
      if (store) store.setItem(KEY, raw);
      else memory.set(KEY, raw);
    } catch {
      // Quota exceeded or storage blocked: keep the session in memory and
      // trim the largest field (the event log) before retrying once.
      try {
        const trimmed = JSON.stringify({
          ...record,
          payload: trimPayload(payload),
        });
        if (store) store.setItem(KEY, trimmed);
        else memory.set(KEY, trimmed);
      } catch {
        memory.set(KEY, raw);
      }
    }
  };

  if (debounceMs <= 0) {
    write();
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(write, debounceMs);
}

export function flushSave(payload: unknown): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveState(payload, 0);
}

/** Drops the bulkiest, least valuable fields to get under quota. */
function trimPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  const next = { ...p };
  if (p.agent && typeof p.agent === 'object') {
    const agent = p.agent as Record<string, unknown>;
    next.agent = {
      ...agent,
      events: Array.isArray(agent.events) ? agent.events.slice(-40) : agent.events,
      equityCurve: Array.isArray(agent.equityCurve)
        ? agent.equityCurve.slice(-500)
        : agent.equityCurve,
    };
  }
  if (Array.isArray(next.candleCache)) next.candleCache = [];
  if (next.candles && typeof next.candles === 'object') next.candles = {};
  return next;
}

export function clearState(): void {
  const store = backing();
  try {
    if (store) store.removeItem(KEY);
  } catch {
    /* ignore */
  }
  memory.delete(KEY);
}

/** Rough byte size of persisted state, for the Settings readout. */
export function storageBytes(): number {
  const store = backing();
  const raw = store ? store.getItem(KEY) : memory.get(KEY);
  return raw ? raw.length : 0;
}

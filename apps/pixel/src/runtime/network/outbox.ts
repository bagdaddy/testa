/**
 * Durable event outbox with FIFO ordering, bounded capacity, and graceful
 * degradation across storage backends.
 *
 * Strategy:
 *   - Primary: IndexedDB. Survives page reloads, tab closes, browser restarts.
 *   - Fallback: localStorage. Used in Safari Private Mode and a few exotic
 *     environments where IDB is blocked. Smaller capacity (~150 entries) but
 *     same FIFO semantics.
 *   - Last resort: in-memory array. Used in test environments / SSR. Lost on
 *     reload, but the runtime has no choice.
 *
 * FIFO ordering relies on UUIDv7 keys — they sort by enqueue time naturally.
 * `pending(N)` returns the oldest N. `markSent(ids)` deletes by id.
 *
 * Capacity bound: 500 entries × ~1 KB ≈ 500 KB. Beyond that, oldest entries
 * are evicted FIFO. We log `dropped` to health counters.
 *
 * `oldestAgeMs(now)` reads the timestamp embedded in the oldest UUIDv7 key.
 * No separate `created_at` column needed — the key IS the timestamp.
 */

import { recordDropped, recordQueued } from './health.ts';

const DB_NAME = '_testa_outbox';
const DB_VERSION = 1;
const STORE_NAME = 'events';
const LS_KEY = '_testa_outbox_ls';
const MAX_ENTRIES = 500;
const LS_MAX_ENTRIES = 150;

export interface OutboxEntry {
  /** UUIDv7 — also serves as the IDB key and the FIFO sort key. */
  event_id: string;
  /** Serialized event payload — what we POST to /track. */
  payload: string;
}

interface Backend {
  enqueue(entry: OutboxEntry): Promise<void>;
  pending(limit: number): Promise<OutboxEntry[]>;
  markSent(ids: readonly string[]): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

let _backend: Backend | null = null;

/**
 * Initialize / pick the storage backend. Idempotent. Test code can inject
 * a stub via `__setBackendForTests`.
 */
export async function initOutbox(): Promise<void> {
  if (_backend) return;
  if (await idbAvailable()) {
    _backend = await openIdbBackend();
    return;
  }
  if (lsAvailable()) {
    _backend = createLsBackend();
    return;
  }
  _backend = createMemoryBackend();
}

export async function enqueue(entry: OutboxEntry): Promise<void> {
  await initOutbox();
  if (!_backend) throw new Error('outbox not initialized');
  const before = await _backend.count();
  if (before >= MAX_ENTRIES) {
    // Evict oldest to make room.
    const oldest = await _backend.pending(1);
    if (oldest.length > 0 && oldest[0]) {
      await _backend.markSent([oldest[0].event_id]);
      recordDropped(1);
    }
  }
  await _backend.enqueue(entry);
  recordQueued(1);
}

export async function pending(limit: number): Promise<OutboxEntry[]> {
  await initOutbox();
  if (!_backend) return [];
  return _backend.pending(limit);
}

export async function markSent(ids: readonly string[]): Promise<void> {
  await initOutbox();
  if (!_backend) return;
  await _backend.markSent(ids);
}

export async function count(): Promise<number> {
  await initOutbox();
  if (!_backend) return 0;
  return _backend.count();
}

/**
 * Age (in ms) of the oldest entry, or 0 when the outbox is empty.
 *
 * Reads the 48-bit timestamp embedded in the UUIDv7 key — no separate
 * `created_at` column needed.
 */
export async function oldestAgeMs(now: number = Date.now()): Promise<number> {
  await initOutbox();
  if (!_backend) return 0;
  const head = await _backend.pending(1);
  if (head.length === 0 || !head[0]) return 0;
  const ts = uuidv7Timestamp(head[0].event_id);
  if (ts === null) return 0;
  return Math.max(0, now - ts);
}

/**
 * Decode the 48-bit unix-ms timestamp from a UUIDv7 string. Returns null on
 * a non-v7 input. The string-prefix decode is faster than allocating a
 * Uint8Array — outbox checks this on every flush.
 */
export function uuidv7Timestamp(uuid: string): number | null {
  if (uuid.length < 18) return null;
  // First 8 hex chars + first 4 hex chars after the first dash = 48 bits.
  const hex = uuid.slice(0, 8) + uuid.slice(9, 13);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  // Parse as a 48-bit number. Number.MAX_SAFE_INTEGER is 2^53-1, so 48 bits fit.
  return Number.parseInt(hex, 16);
}

// ─── IndexedDB backend ─────────────────────────────────────────────────────

async function idbAvailable(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const req = indexedDB.open('_testa_idb_probe');
    return await new Promise<boolean>((resolve) => {
      req.onsuccess = () => {
        req.result.close();
        try {
          indexedDB.deleteDatabase('_testa_idb_probe');
        } catch {
          // ignore
        }
        resolve(true);
      };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function openIdbBackend(): Promise<Backend> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const dbInst = req.result;
      if (!dbInst.objectStoreNames.contains(STORE_NAME)) {
        // Use event_id as the keyPath so UUIDv7's lexicographic order maps to
        // FIFO insertion order.
        dbInst.createObjectStore(STORE_NAME, { keyPath: 'event_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function tx(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  return {
    enqueue: (entry) =>
      new Promise<void>((resolve, reject) => {
        const req = tx('readwrite').put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    pending: (limit) =>
      new Promise<OutboxEntry[]>((resolve, reject) => {
        const out: OutboxEntry[] = [];
        const req = tx('readonly').openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(sortByIdAsc(out).slice(0, limit));
            return;
          }
          out.push(cursor.value as OutboxEntry);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }),
    markSent: (ids) =>
      new Promise<void>((resolve, reject) => {
        const store = tx('readwrite');
        let remaining = ids.length;
        if (remaining === 0) {
          resolve();
          return;
        }
        for (const id of ids) {
          const req = store.delete(id);
          req.onsuccess = () => {
            remaining -= 1;
            if (remaining === 0) resolve();
          };
          req.onerror = () => reject(req.error);
        }
      }),
    count: () =>
      new Promise<number>((resolve, reject) => {
        const req = tx('readonly').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
    clear: () =>
      new Promise<void>((resolve, reject) => {
        const req = tx('readwrite').clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
  };
}

// ─── localStorage backend ──────────────────────────────────────────────────

function lsAvailable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem('_testa_ls_probe', '1');
    localStorage.removeItem('_testa_ls_probe');
    return true;
  } catch {
    return false;
  }
}

function createLsBackend(): Backend {
  function read(): OutboxEntry[] {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
    } catch {
      return [];
    }
  }

  function write(entries: OutboxEntry[]): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(entries));
    } catch {
      // Quota exceeded — drop silently and rely on health counter.
    }
  }

  return {
    enqueue: async (entry) => {
      const entries = read();
      entries.push(entry);
      while (entries.length > LS_MAX_ENTRIES) {
        entries.shift();
        recordDropped(1);
      }
      write(entries);
    },
    pending: async (limit) => sortByIdAsc(read()).slice(0, limit),
    markSent: async (ids) => {
      const set = new Set(ids);
      write(read().filter((e) => !set.has(e.event_id)));
    },
    count: async () => read().length,
    clear: async () => {
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        // ignore
      }
    },
  };
}

// ─── memory backend (test + SSR fallback) ──────────────────────────────────

function createMemoryBackend(): Backend {
  let entries: OutboxEntry[] = [];
  return {
    enqueue: async (entry) => {
      entries.push(entry);
    },
    pending: async (limit) => entries.slice(0, limit),
    markSent: async (ids) => {
      const set = new Set(ids);
      entries = entries.filter((e) => !set.has(e.event_id));
    },
    count: async () => entries.length,
    clear: async () => {
      entries = [];
    },
  };
}

/** UUIDv7 keys sort lexicographically by embedded timestamp. */
function sortByIdAsc(entries: OutboxEntry[]): OutboxEntry[] {
  return [...entries].sort((a, b) =>
    a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0,
  );
}

// ─── test hook ─────────────────────────────────────────────────────────────

export function __setBackendForTests(b: Backend | null): void {
  _backend = b;
}

export async function __resetForTests(): Promise<void> {
  if (_backend) {
    try {
      await _backend.clear();
    } catch {
      // ignore
    }
  }
  _backend = null;
}

/**
 * Legacy `window.Analytica.eventEmitter` — same shape and semantics as the
 * 3.6 emitter. History replay for late subscribers, WeakMap dedup, error
 * isolation across handlers.
 *
 * Reference: `docs/reference/legacy-globals-inventory.md` § Methods/objects.
 */

type EventData = unknown;
type Handler = (data: EventData) => void;
type ListenerEntry = [string, Handler];

interface EventHistoryEntry {
  data: EventData;
  timestamp: number;
}

export interface AnalyticaEventEmitter {
  emit(eventName: string, data: EventData): void;
  on(eventName: string, handler: Handler): void;
  /** Stored event-fire history per name. Replayed for late subscribers. */
  eventHistory: Record<string, EventHistoryEntry[]>;
  /** Dedup tracking — each handler tracks which event values it's already seen. */
  handlerProcessedEvents: WeakMap<Handler, Set<string>>;
  /** @internal */
  _processEvent(eventName: string, data: EventData): void;
  /** @internal */
  _processHistoryForHandler(eventName: string, handler: Handler): void;
}

/**
 * Build the emitter and the listeners array. Returns both because the legacy
 * surface exposes them as separate window.Analytica fields.
 */
export function createEventEmitter(): {
  emitter: AnalyticaEventEmitter;
  listeners: ListenerEntry[];
} {
  const listeners: ListenerEntry[] = [];

  const emitter: AnalyticaEventEmitter = {
    eventHistory: {},
    handlerProcessedEvents: new WeakMap<Handler, Set<string>>(),

    emit(eventName, data) {
      // Stash in history so late subscribers get replayed.
      const bucket = emitter.eventHistory[eventName] ?? [];
      bucket.push({ data, timestamp: Date.now() });
      emitter.eventHistory[eventName] = bucket;

      emitter._processEvent(eventName, data);
    },

    on(eventName, handler) {
      if (typeof handler !== 'function') return;
      listeners.push([eventName, handler]);
      emitter._processHistoryForHandler(eventName, handler);
    },

    _processEvent(eventName, data) {
      for (const [name, handler] of listeners) {
        if (name !== eventName) continue;
        const processed = emitter.handlerProcessedEvents.get(handler) ?? new Set<string>();
        const key = stableKey(data);
        if (processed.has(key)) continue;
        try {
          handler(data);
        } catch {
          // 3.6 silently swallowed handler throws; we keep that behavior.
        }
        processed.add(key);
        emitter.handlerProcessedEvents.set(handler, processed);
      }
    },

    _processHistoryForHandler(eventName, handler) {
      const bucket = emitter.eventHistory[eventName];
      if (!bucket) return;
      const processed = emitter.handlerProcessedEvents.get(handler) ?? new Set<string>();
      for (const { data } of bucket) {
        const key = stableKey(data);
        if (processed.has(key)) continue;
        try {
          handler(data);
        } catch {
          // ignore
        }
        processed.add(key);
      }
      emitter.handlerProcessedEvents.set(handler, processed);
    },
  };

  return { emitter, listeners };
}

/**
 * Stable string key for dedup. JSON.stringify covers the common case
 * (objects, primitives, arrays). Falls back to `toString` for cyclic /
 * unstringifiable inputs.
 */
function stableKey(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

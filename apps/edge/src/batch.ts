import type { EnrichedEvent } from '@testa-platform/shared-types';
import type { Env } from './types.ts';

/**
 * BatchBuffer DurableObject — buffers EnrichedEvents and flushes:
 *   - immediately when the buffer hits FLUSH_AT_COUNT, OR
 *   - via a single 500 ms alarm after the first add to a fresh buffer.
 *
 * Phase 2.5 ships the buffering + alarm logic with a stub flush function.
 * Phase 2.6 swaps in the real HMAC-signed POST to the collector.
 *
 * Buffer is in-memory only — events lost on DO eviction are acceptable
 * at v1 scale; persisting per-add to DO storage would multiply latency.
 */

export const FLUSH_AFTER_MS = 500;
export const FLUSH_AT_COUNT = 50;
export const INITIAL_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8_000;

export type FlushFn = (events: readonly EnrichedEvent[]) => Promise<void>;

/**
 * Default flush — Phase 2.5 stub. Phase 2.6 replaces with HMAC sign + POST.
 * Exported so tests can swap it cleanly.
 */
export const defaultFlush: FlushFn = async (events) => {
  // Phase 2.6 will replace this with: forwardBatch(events, env)
  console.log('[batch] would flush', events.length);
};

export class BatchBuffer implements DurableObject {
  private readonly state: DurableObjectState;
  private buffer: EnrichedEvent[] = [];
  private flushing = false;
  private backoff = 0;
  private flushFn: FlushFn = defaultFlush;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  /** Test-only: swap the flush implementation. */
  __setFlushFnForTests(fn: FlushFn): void {
    this.flushFn = fn;
  }

  /** Test-only: peek at internal buffer length. */
  __bufferLengthForTests(): number {
    return this.buffer.length;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/add' && request.method === 'POST') {
      const event = (await request.json()) as EnrichedEvent;
      await this.add(event);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/flush' && request.method === 'POST') {
      await this.flush();
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }

  async add(event: EnrichedEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_AT_COUNT) {
      await this.flush();
      return;
    }
    const existing = await this.state.storage.getAlarm();
    if (existing == null) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_AFTER_MS);
    }
  }

  async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.slice();
    this.buffer = [];
    try {
      await this.flushFn(batch);
      this.backoff = 0;
    } catch (err) {
      // restore in original order, schedule retry with exp backoff
      this.buffer = [...batch, ...this.buffer];
      this.backoff =
        this.backoff === 0 ? INITIAL_BACKOFF_MS : Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      await this.state.storage.setAlarm(Date.now() + this.backoff);
      console.error('[batch] flush failed; retry in', this.backoff, 'ms', err);
    } finally {
      this.flushing = false;
    }
  }
}

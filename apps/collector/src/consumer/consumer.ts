/**
 * Redis Stream → ClickHouse consumer.
 *
 * Loops `XREADGROUP` with a per-group consumer name, batches up to `batchSize`
 * events (or `maxWaitMs` blocking), inserts into `events_buffer`, then ACKs.
 * On ClickHouse errors we DO NOT ACK, so events stay in the PEL and get
 * redelivered after `start()` recovers — there's no data loss path under
 * transient CH outages. Exponential backoff caps consumer pressure.
 *
 * Designed to be unit-startable (`new Consumer({...}); await c.start()`) so
 * tests can drive it without a process boundary.
 */

import type { EnrichedEvent } from '@testa-platform/shared-types';
import type { Redis } from 'ioredis';
import { rowFromEvent } from '../db/row-mapper.ts';

export interface ConsumerDeps {
  redis: Redis;
  /** Inserts rows into ClickHouse `events_buffer`. Throws on failure. */
  insertEvents: (rows: readonly object[]) => Promise<void>;
  streamKey: string;
  consumerGroup: string;
  consumerName: string;
  batchSize: number;
  /** XREADGROUP BLOCK milliseconds. */
  blockMs: number;
  /** Initial backoff after a CH error (doubles each retry, capped). */
  backoffStartMs?: number;
  backoffMaxMs?: number;
  /**
   * After this many consecutive failures on the same batch, treat as poison
   * and ACK to drop. Prevents infinite retries on schema-malformed events
   * (e.g., non-UUID event_id) that ClickHouse will never accept.
   */
  poisonRetries?: number;
  /** Optional logger. Defaults to console. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: object) => void;
}

const DEFAULT_BACKOFF_START = 500;
const DEFAULT_BACKOFF_MAX = 30_000;
const DEFAULT_POISON_RETRIES = 5;

interface PendingEntry {
  id: string;
  event: EnrichedEvent;
}

export class Consumer {
  private readonly deps: Required<
    Omit<ConsumerDeps, 'log' | 'backoffStartMs' | 'backoffMaxMs' | 'poisonRetries'>
  > & {
    log: NonNullable<ConsumerDeps['log']>;
    backoffStartMs: number;
    backoffMaxMs: number;
    poisonRetries: number;
  };
  private running = false;
  private stopResolve: (() => void) | null = null;
  /** Tracks consecutive failures per stream-id so we can drop poison entries. */
  private failureCount = new Map<string, number>();

  constructor(deps: ConsumerDeps) {
    this.deps = {
      ...deps,
      backoffStartMs: deps.backoffStartMs ?? DEFAULT_BACKOFF_START,
      backoffMaxMs: deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX,
      poisonRetries: deps.poisonRetries ?? DEFAULT_POISON_RETRIES,
      log:
        deps.log ??
        ((level, msg, meta) => {
          const line = meta
            ? `[consumer] [${level}] ${msg} ${JSON.stringify(meta)}`
            : `[consumer] [${level}] ${msg}`;
          if (level === 'error') console.error(line);
          else console.log(line);
        }),
    };
  }

  /** Idempotently create the consumer group, ignoring BUSYGROUP. */
  async ensureGroup(): Promise<void> {
    const { redis, streamKey, consumerGroup, log } = this.deps;
    try {
      await redis.xgroup('CREATE', streamKey, consumerGroup, '$', 'MKSTREAM');
      log('info', 'created consumer group', { streamKey, consumerGroup });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('BUSYGROUP')) throw err;
    }
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    this.deps.log('info', 'consumer started', {
      streamKey: this.deps.streamKey,
      group: this.deps.consumerGroup,
      name: this.deps.consumerName,
      batchSize: this.deps.batchSize,
    });

    let backoff = this.deps.backoffStartMs;
    while (this.running) {
      const entries = await this.readBatch();
      if (entries.length === 0) continue;

      try {
        await this.flush(entries);
        for (const e of entries) this.failureCount.delete(e.id);
        backoff = this.deps.backoffStartMs;
      } catch (err) {
        const poisoned: string[] = [];
        for (const e of entries) {
          const n = (this.failureCount.get(e.id) ?? 0) + 1;
          if (n >= this.deps.poisonRetries) {
            poisoned.push(e.id);
            this.failureCount.delete(e.id);
          } else {
            this.failureCount.set(e.id, n);
          }
        }
        this.deps.log('error', 'flush failed', {
          err: (err as Error).message,
          batch: entries.length,
          backoffMs: backoff,
          poisoned: poisoned.length,
        });
        if (poisoned.length > 0) {
          this.deps.log('warn', 'dropping poison entries (CH rejected after N retries)', {
            ids: poisoned,
          });
          await this.deps.redis.xack(this.deps.streamKey, this.deps.consumerGroup, ...poisoned);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, this.deps.backoffMaxMs);
      }
    }

    this.stopResolve?.();
  }

  /** Stop the loop. Resolves once the in-flight iteration finishes. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await new Promise<void>((res) => {
      this.stopResolve = res;
    });
  }

  /** Test-only: read & flush exactly one batch. Useful for deterministic tests. */
  async tick(): Promise<{ flushed: number; failed: boolean }> {
    await this.ensureGroup();
    const entries = await this.readBatch();
    if (entries.length === 0) return { flushed: 0, failed: false };
    try {
      await this.flush(entries);
      return { flushed: entries.length, failed: false };
    } catch {
      return { flushed: 0, failed: true };
    }
  }

  private async readBatch(): Promise<PendingEntry[]> {
    const { redis, streamKey, consumerGroup, consumerName, batchSize, blockMs } = this.deps;

    // First drain our own pending list (id=0): entries we've been delivered but
    // haven't ACKed (e.g., previous flush failed). Then read new entries (id=>).
    // This is the standard XREADGROUP-recovery pattern.
    let reply: Array<[string, Array<[string, string[]]>]> | null;
    try {
      const pendingFirst = (await redis.xreadgroup(
        'GROUP',
        consumerGroup,
        consumerName,
        'COUNT',
        batchSize,
        'STREAMS',
        streamKey,
        '0',
      )) as Array<[string, Array<[string, string[]]>]> | null;

      const havePending = pendingFirst?.some(([, entries]) => entries.length > 0);

      reply = havePending
        ? pendingFirst
        : ((await redis.xreadgroup(
            'GROUP',
            consumerGroup,
            consumerName,
            'COUNT',
            batchSize,
            'BLOCK',
            blockMs,
            'STREAMS',
            streamKey,
            '>',
          )) as Array<[string, Array<[string, string[]]>]> | null);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // Stream was deleted/flushed under us — recreate the group and try once more.
      if (msg.includes('NOGROUP')) {
        this.deps.log('warn', 'NOGROUP — recreating consumer group', {
          streamKey,
          consumerGroup,
        });
        await this.ensureGroup();
        return [];
      }
      throw err;
    }

    if (!reply || reply.length === 0) return [];

    const out: PendingEntry[] = [];
    for (const [, entries] of reply) {
      for (const [id, fields] of entries) {
        const evIdx = fields.indexOf('ev');
        if (evIdx < 0 || !fields[evIdx + 1]) continue;
        try {
          const event = JSON.parse(fields[evIdx + 1] as string) as EnrichedEvent;
          out.push({ id, event });
        } catch (err) {
          this.deps.log('warn', 'dropping unparseable stream entry', {
            id,
            err: (err as Error).message,
          });
          // ACK so we don't loop on garbage forever.
          await redis.xack(streamKey, consumerGroup, id);
        }
      }
    }
    return out;
  }

  private async flush(entries: PendingEntry[]): Promise<void> {
    const rows = entries.map((e) => rowFromEvent(e.event));
    await this.deps.insertEvents(rows);
    const ids = entries.map((e) => e.id);
    await this.deps.redis.xack(this.deps.streamKey, this.deps.consumerGroup, ...ids);
    this.deps.log('info', 'flushed batch', { count: entries.length });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

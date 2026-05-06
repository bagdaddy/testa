import type { EnrichedEvent } from '@testa-platform/shared-types';
import { describe, expect, it, vi } from 'vitest';
import {
  BatchBuffer,
  FLUSH_AFTER_MS,
  FLUSH_AT_COUNT,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../batch.ts';
import type { Env } from '../types.ts';

/**
 * Minimal stub of DurableObjectState. The BatchBuffer only uses
 * `state.storage.{getAlarm, setAlarm}`; everything else is dead weight.
 */
function makeState(): {
  state: DurableObjectState;
  getAlarm: () => number | null;
  setAlarm: (n: number) => void;
} {
  let alarm: number | null = null;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (n: number | Date) => {
      alarm = typeof n === 'number' ? n : n.getTime();
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;

  return {
    state: { storage } as unknown as DurableObjectState,
    getAlarm: () => alarm,
    setAlarm: (n: number) => {
      alarm = n;
    },
  };
}

function makeEvent(i: number): EnrichedEvent {
  return {
    event_id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    event_name: 'page_view',
    client_ts: Date.now(),
    project_id: 1,
    visitor_id: 'v1',
    session_id: 's1',
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1920,
    viewport_h: 1080,
    server_ts: Date.now(),
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
  } as EnrichedEvent;
}

const env = {} as Env;

describe('BatchBuffer', () => {
  it('does not flush before FLUSH_AT_COUNT', async () => {
    const { state, getAlarm } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockResolvedValue(undefined);
    buf.__setFlushFnForTests(fn);

    for (let i = 0; i < FLUSH_AT_COUNT - 1; i++) await buf.add(makeEvent(i));

    expect(fn).not.toHaveBeenCalled();
    expect(buf.__bufferLengthForTests()).toBe(FLUSH_AT_COUNT - 1);
    // First add scheduled an alarm.
    expect(getAlarm()).toBeGreaterThan(Date.now() - 100);
  });

  it('flushes immediately at FLUSH_AT_COUNT events', async () => {
    const { state } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockResolvedValue(undefined);
    buf.__setFlushFnForTests(fn);

    for (let i = 0; i < FLUSH_AT_COUNT; i++) await buf.add(makeEvent(i));

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]?.[0]).toHaveLength(FLUSH_AT_COUNT);
    expect(buf.__bufferLengthForTests()).toBe(0);
  });

  it('alarm() flushes any pending events', async () => {
    const { state } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockResolvedValue(undefined);
    buf.__setFlushFnForTests(fn);

    for (let i = 0; i < 5; i++) await buf.add(makeEvent(i));
    await buf.alarm();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]?.[0]).toHaveLength(5);
    expect(buf.__bufferLengthForTests()).toBe(0);
  });

  it('on flush failure: events are restored and backoff alarm scheduled', async () => {
    const { state, getAlarm } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom'));
    buf.__setFlushFnForTests(fn);

    for (let i = 0; i < 3; i++) await buf.add(makeEvent(i));
    await buf.alarm();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(buf.__bufferLengthForTests()).toBe(3);
    const alarm = getAlarm();
    expect(alarm).not.toBeNull();
    if (alarm === null) throw new Error('unreachable');
    // First failure → INITIAL_BACKOFF_MS
    expect(alarm - Date.now()).toBeGreaterThan(0);
    expect(alarm - Date.now()).toBeLessThanOrEqual(INITIAL_BACKOFF_MS + 50);
  });

  it('backoff caps at MAX_BACKOFF_MS', async () => {
    const { state, getAlarm } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockRejectedValue(new Error('persistent'));
    buf.__setFlushFnForTests(fn);

    await buf.add(makeEvent(0));
    // 5 consecutive failures: 500, 1000, 2000, 4000, 8000 (capped)
    for (let i = 0; i < 6; i++) await buf.alarm();

    const alarm = getAlarm();
    expect(alarm).not.toBeNull();
    if (alarm === null) throw new Error('unreachable');
    expect(alarm - Date.now()).toBeLessThanOrEqual(MAX_BACKOFF_MS + 100);
    expect(alarm - Date.now()).toBeGreaterThan(MAX_BACKOFF_MS / 2);
  });

  it('fetch /add endpoint enqueues an event', async () => {
    const { state } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockResolvedValue(undefined);
    buf.__setFlushFnForTests(fn);

    const ev = makeEvent(1);
    const res = await buf.fetch(
      new Request('https://x/add', { method: 'POST', body: JSON.stringify(ev) }),
    );
    expect(res.status).toBe(204);
    expect(buf.__bufferLengthForTests()).toBe(1);
  });

  it('schedules exactly one alarm even after many adds', async () => {
    const { state, getAlarm } = makeState();
    const buf = new BatchBuffer(state, env);
    const fn = vi.fn().mockResolvedValue(undefined);
    buf.__setFlushFnForTests(fn);

    const beforeAlarm = Date.now();
    for (let i = 0; i < 10; i++) await buf.add(makeEvent(i));

    const alarm = getAlarm();
    expect(alarm).not.toBeNull();
    if (alarm === null) throw new Error('unreachable');
    // Alarm timestamp should be ~ first-add + FLUSH_AFTER_MS, not refreshed by later adds.
    expect(alarm - beforeAlarm).toBeGreaterThanOrEqual(FLUSH_AFTER_MS - 5);
    expect(alarm - beforeAlarm).toBeLessThanOrEqual(FLUSH_AFTER_MS + 50);
  });
});

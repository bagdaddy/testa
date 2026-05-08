import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests as resetHealth, snapshot } from '../health.ts';
import { count, enqueue, __resetForTests as resetOutbox } from '../outbox.ts';
import {
  __getBackoffMsForTests,
  flush,
  installTransport,
  notifyEnqueue,
  __resetForTests as resetTransport,
} from '../transport.ts';
import { uuidv7 } from '../uuid7.ts';

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetOutbox();
  resetHealth();
  resetTransport();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterEach(async () => {
  await resetOutbox();
  resetHealth();
  resetTransport();
  globalThis.fetch = realFetch;
});

const ENDPOINT = 'https://track.example.com/track';

async function enqueueOne(): Promise<string> {
  const id = uuidv7();
  await enqueue({ event_id: id, payload: `{"id":"${id}"}` });
  return id;
}

describe('flush — happy path', () => {
  it('POSTs the batch as a JSON array, marks sent, resets backoff', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    installTransport({ endpoint: ENDPOINT });

    await enqueueOne();
    await enqueueOne();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    const body = (init as RequestInit).body as string;
    expect(body.startsWith('[')).toBe(true);
    expect(body.endsWith(']')).toBe(true);

    expect(await count()).toBe(0);
    const snap = snapshot(0);
    expect(snap.sent).toBe(2);
    expect(__getBackoffMsForTests()).toBe(0);
  });

  it('flush is a no-op when outbox is empty', async () => {
    installTransport({ endpoint: ENDPOINT });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flush — failure paths', () => {
  it('5xx leaves events in outbox, schedules backoff', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    installTransport({ endpoint: ENDPOINT });
    await enqueueOne();
    await flush();

    expect(await count()).toBe(1);
    const snap = snapshot(0);
    expect(snap.retried).toBe(1);
    expect(__getBackoffMsForTests()).toBeGreaterThanOrEqual(500);
  });

  it('network error leaves events, schedules backoff', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    installTransport({ endpoint: ENDPOINT });
    await enqueueOne();
    await flush();

    expect(await count()).toBe(1);
    expect(snapshot(0).retried).toBe(1);
  });

  it('4xx is poison — drop the batch, do not retry', async () => {
    fetchMock.mockResolvedValue(new Response('schema error', { status: 400 }));
    installTransport({ endpoint: ENDPOINT });
    await enqueueOne();
    await flush();

    expect(await count()).toBe(0);
    expect(snapshot(0).dropped).toBe(1);
    expect(__getBackoffMsForTests()).toBe(0);
  });

  it('exp backoff doubles on consecutive 5xx, capped', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    installTransport({ endpoint: ENDPOINT });
    await enqueueOne();

    await flush();
    const after1 = __getBackoffMsForTests();
    await flush();
    const after2 = __getBackoffMsForTests();
    await flush();
    const after3 = __getBackoffMsForTests();

    expect(after2).toBeGreaterThanOrEqual(after1);
    expect(after3).toBeGreaterThanOrEqual(after2);
    // Cap at 30s.
    expect(after3).toBeLessThanOrEqual(30_000);
  });
});

describe('notifyEnqueue', () => {
  it('does NOT throw without a configured endpoint', () => {
    expect(() => notifyEnqueue()).not.toThrow();
  });
});

describe('drain after success', () => {
  it('schedules a follow-up flush when more events remain after a successful flush', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    installTransport({ endpoint: ENDPOINT });

    // Enqueue more than MAX_BATCH_SIZE so flush leaves remainder.
    for (let i = 0; i < 60; i++) await enqueueOne();

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // First flush handles 50; rest stays. Wait for the follow-up scheduled flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await count()).toBe(0);
  });
});

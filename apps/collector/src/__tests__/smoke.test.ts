import { afterAll, describe, expect, it } from 'bun:test';
import server from '../index.ts';
import { close as closeRedis } from '../redis/client.ts';

afterAll(async () => {
  await closeRedis();
});

describe('collector smoke', () => {
  it('GET /_internal/health returns a JSON envelope with checks', async () => {
    const res = await server.fetch(new Request('http://test.local/_internal/health'));
    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      checks: { redis: boolean; clickhouse: boolean };
    };
    expect(body.service).toBe('collector');
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.checks.redis).toBe('boolean');
    expect(typeof body.checks.clickhouse).toBe('boolean');
    expect(res.status).toBe(body.ok ? 200 : 503);
  });

  it('POST /_ingest with no signature returns 401', async () => {
    const res = await server.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signed_at: Date.now(), events: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('POST /_ingest with invalid JSON returns 400', async () => {
    const res = await server.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-signature': 'a'.repeat(64) },
        body: 'not-json{',
      }),
    );
    expect(res.status).toBe(400);
  });
});

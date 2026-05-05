import { describe, expect, it } from 'bun:test';
import server from '../index.ts';

describe('collector smoke', () => {
  it('GET /_internal/health returns ok', async () => {
    const res = await server.fetch(new Request('http://test.local/_internal/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('collector');
  });

  it('POST /_ingest returns 501 (not yet implemented)', async () => {
    const res = await server.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(501);
  });
});

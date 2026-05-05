import { describe, expect, it } from 'vitest';
import app from '../index.ts';

describe('edge smoke', () => {
  it('GET /health returns ok', async () => {
    const env = {
      ENVIRONMENT: 'test',
    } as unknown as Parameters<typeof app.fetch>[1];

    const res = await app.fetch(new Request('https://test.local/health'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; environment: string };
    expect(body.ok).toBe(true);
    expect(body.environment).toBe('test');
  });

  it('OPTIONS /track returns 204 with CORS headers', async () => {
    const env = {} as unknown as Parameters<typeof app.fetch>[1];
    const res = await app.fetch(
      new Request('https://test.local/track', { method: 'OPTIONS' }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

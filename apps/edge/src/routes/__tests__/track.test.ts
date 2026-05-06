import { describe, expect, it } from 'vitest';
import app from '../../index.ts';

const env = {} as unknown as Parameters<typeof app.fetch>[1];

describe('OPTIONS /track', () => {
  it('returns 204 with CORS headers', async () => {
    const res = await app.fetch(
      new Request('https://test.local/track', { method: 'OPTIONS' }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('POST /track', () => {
  it('returns 501 (not implemented yet)', async () => {
    const res = await app.fetch(
      new Request('https://test.local/track', { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(501);
  });
});

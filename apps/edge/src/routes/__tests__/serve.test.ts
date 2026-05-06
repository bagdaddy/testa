import { describe, expect, it } from 'vitest';
import app from '../../index.ts';

const env = {} as unknown as Parameters<typeof app.fetch>[1];

describe('GET /projects/:slug.js', () => {
  it('returns 200 with application/javascript', async () => {
    const res = await app.fetch(new Request('https://test.local/projects/abc.js'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('returns the placeholder body for now', async () => {
    const res = await app.fetch(new Request('https://test.local/projects/foo.js'), env);
    expect(await res.text()).toContain('placeholder');
  });

  it('does not match non-.js paths', async () => {
    const res = await app.fetch(new Request('https://test.local/projects/abc'), env);
    expect(res.status).toBe(404);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPreviewRequested, maybeEnterPreviewMode } from '../preview.ts';

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

afterEach(() => {
  setUrl('');
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('isPreviewRequested', () => {
  it('is true only when testa_preview=true', () => {
    setUrl('?testa_preview=true&testa_preview_token=abc');
    expect(isPreviewRequested()).toBe(true);
    setUrl('?foo=bar');
    expect(isPreviewRequested()).toBe(false);
  });
});

describe('maybeEnterPreviewMode', () => {
  it('returns false and does nothing when not in preview', () => {
    setUrl('?foo=bar');
    const fetchImpl = vi.fn();
    const apply = vi.fn();
    expect(maybeEnterPreviewMode({ apiUrl: 'https://api.example', apply, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the preview session and applies the returned changes', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok-9');
    const changes = [{ type: 'hide', selector: '.x' }];
    const fetchImpl = vi.fn(async () => jsonResponse({ changes }));
    const apply = vi.fn();

    const handled = maybeEnterPreviewMode({ apiUrl: 'https://api.example/', apply, fetchImpl });
    expect(handled).toBe(true);
    // let the fetch promise + apply microtasks settle
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/api/preview/tok-9');
    expect(apply).toHaveBeenCalledWith(-1, changes);
  });

  it('skips the normal cycle but applies nothing when token is missing', () => {
    setUrl('?testa_preview=true');
    const fetchImpl = vi.fn();
    const apply = vi.fn();
    expect(maybeEnterPreviewMode({ apiUrl: 'https://api.example', apply, fetchImpl })).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applies nothing when the response is not ok', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ changes: [{ type: 'hide', selector: '.x' }] }, false),
    );
    const apply = vi.fn();
    maybeEnterPreviewMode({ apiUrl: 'https://api.example', apply, fetchImpl });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(apply).not.toHaveBeenCalled();
  });
});

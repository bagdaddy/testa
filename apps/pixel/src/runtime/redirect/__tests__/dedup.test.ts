import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRedirected, hasRedirected, markRedirected, redirectedName } from '../dedup.ts';

beforeEach(() => {
  clearAllCookies();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  clearAllCookies();
});

function clearAllCookies(): void {
  if (typeof document === 'undefined') return;
  for (const c of document.cookie.split(';')) {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? c : c.slice(0, eq)).trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
  }
}

describe('dedup', () => {
  it('starts un-redirected', () => {
    expect(hasRedirected(17)).toBe(false);
  });

  it('mark + check round-trips', () => {
    markRedirected(17);
    expect(hasRedirected(17)).toBe(true);
  });

  it('clear removes the flag', () => {
    markRedirected(17);
    clearRedirected(17);
    expect(hasRedirected(17)).toBe(false);
  });

  it('flags are namespaced per experiment', () => {
    markRedirected(17);
    expect(hasRedirected(18)).toBe(false);
  });

  it('cookie name is per-experiment', () => {
    expect(redirectedName(42)).toBe('_testa_redirected_42');
  });
});

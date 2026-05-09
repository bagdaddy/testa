import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllCookies, clearStorages } from '../../../__test-utils__/reset.ts';
import { clearRedirected, hasRedirected, markRedirected, redirectedName } from '../dedup.ts';

beforeEach(() => {
  clearAllCookies();
  clearStorages();
});

afterEach(() => {
  clearAllCookies();
});

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

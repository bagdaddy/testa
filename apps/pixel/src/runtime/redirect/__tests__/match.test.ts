import { describe, expect, it } from 'vitest';
import { canonicalize, matchesUrl } from '../match.ts';

describe('canonicalize', () => {
  it('lowercases the host', () => {
    expect(canonicalize('https://Example.COM/path')).toBe('https://example.com/path');
  });

  it('drops _testa_* query params', () => {
    expect(canonicalize('https://x.com/a?_testa_session=1&keep=2')).toBe('https://x.com/a?keep=2');
  });

  it('sorts remaining query keys', () => {
    expect(canonicalize('https://x.com/a?b=1&a=2')).toBe('https://x.com/a?a=2&b=1');
  });

  it('strips trailing slash on non-root paths', () => {
    expect(canonicalize('https://x.com/a/')).toBe('https://x.com/a');
  });

  it('preserves trailing slash on root', () => {
    expect(canonicalize('https://x.com/')).toBe('https://x.com/');
  });

  it('drops the fragment', () => {
    expect(canonicalize('https://x.com/a#section')).toBe('https://x.com/a');
  });
});

describe('matchesUrl — exact', () => {
  it('matches canonical equality', () => {
    expect(matchesUrl('https://x.com/a', 'https://x.com/a')).toBe(true);
  });

  it('matches across cosmetic differences (case, trailing slash, _testa_ params)', () => {
    expect(matchesUrl('https://X.com/a/?_testa_x=1', 'https://x.com/a')).toBe(true);
  });

  it('does not match when paths differ', () => {
    expect(matchesUrl('https://x.com/a', 'https://x.com/b')).toBe(false);
  });
});

describe('matchesUrl — glob', () => {
  it('matches a wildcard at the end', () => {
    expect(matchesUrl('https://x.com/products/123', 'https://x.com/products/*')).toBe(true);
  });

  it('matches a wildcard in the middle', () => {
    expect(matchesUrl('https://x.com/a/b/c', 'https://x.com/a/*/c')).toBe(true);
  });

  it('does not match when prefix differs', () => {
    expect(matchesUrl('https://x.com/blog/123', 'https://x.com/products/*')).toBe(false);
  });
});

describe('matchesUrl — regex', () => {
  it('matches when the prefix is `regex:`', () => {
    expect(matchesUrl('https://x.com/p/42', 'regex:^https://x\\.com/p/\\d+$')).toBe(true);
  });

  it('returns false on an invalid regex (not throw)', () => {
    expect(matchesUrl('https://x.com/p', 'regex:[unterminated')).toBe(false);
  });
});

describe('matchesUrl — empty', () => {
  it('returns false on an empty pattern', () => {
    expect(matchesUrl('https://x.com/a', '')).toBe(false);
  });
});

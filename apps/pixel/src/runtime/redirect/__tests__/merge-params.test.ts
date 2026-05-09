import { describe, expect, it } from 'vitest';
import { mergeParams } from '../merge-params.ts';

describe('mergeParams — preservation', () => {
  it('preserves utm_* from current onto destination', () => {
    const out = mergeParams(
      'https://customer.com/a?utm_source=fb&utm_medium=cpc',
      'https://customer.com/b',
    );
    const url = new URL(out);
    expect(url.searchParams.get('utm_source')).toBe('fb');
    expect(url.searchParams.get('utm_medium')).toBe('cpc');
  });

  it('destination params win over current', () => {
    const out = mergeParams('https://x.com/a?id=1', 'https://x.com/b?id=2');
    expect(new URL(out).searchParams.get('id')).toBe('2');
  });

  it('drops _testa_* params from current', () => {
    const out = mergeParams('https://x.com/a?_testa_session=1&utm_source=g', 'https://x.com/b');
    const url = new URL(out);
    expect(url.searchParams.has('_testa_session')).toBe(false);
    expect(url.searchParams.get('utm_source')).toBe('g');
  });

  it('keeps destination params when current is empty', () => {
    const out = mergeParams('https://x.com/a', 'https://x.com/b?keep=me');
    expect(new URL(out).searchParams.get('keep')).toBe('me');
  });
});

describe('mergeParams — degenerate input', () => {
  it('returns the target unchanged when current URL is malformed', () => {
    const out = mergeParams('not a url', 'https://x.com/b?a=1');
    expect(new URL(out).searchParams.get('a')).toBe('1');
  });

  it('returns the target raw when target URL is malformed', () => {
    const out = mergeParams('https://x.com/a', 'not a url');
    // URL parsed against placeholder base — string round-trips with placeholder.
    expect(out).toContain('not%20a%20url');
  });
});

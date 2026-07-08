import type { VariationChange } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { buildRedirectUrl, resolveMode } from '../build-url.ts';

type RedirectChange = Extract<VariationChange, { type: 'redirect' }>;

const redirect = (partial: Omit<RedirectChange, 'type'>): RedirectChange => ({
  type: 'redirect',
  ...partial,
});

describe('resolveMode', () => {
  it('defaults to exact when url_match_type is absent', () => {
    expect(resolveMode(redirect({ from_url: 'a', to_url: 'b' }))).toBe('exact');
  });

  it('returns the explicit mode', () => {
    expect(resolveMode(redirect({ from_url: 'a', to_url: 'b', url_match_type: 'regex' }))).toBe(
      'regex',
    );
  });
});

describe('buildRedirectUrl — exact', () => {
  it('merges current query params, destination wins conflicts', () => {
    const out = buildRedirectUrl(
      'https://x.com/a?utm_source=fb&id=1',
      redirect({
        from_url: 'https://x.com/a',
        to_url: 'https://x.com/b?id=2',
        url_match_type: 'exact',
      }),
    );
    const url = new URL(out);
    expect(url.origin + url.pathname).toBe('https://x.com/b');
    expect(url.searchParams.get('utm_source')).toBe('fb'); // filled from current
    expect(url.searchParams.get('id')).toBe('2'); // destination wins
  });

  it('uses the destination own search when current has no params', () => {
    const out = buildRedirectUrl(
      'https://x.com/a',
      redirect({ from_url: 'https://x.com/a', to_url: 'https://x.com/b?keep=me' }),
    );
    expect(new URL(out).searchParams.get('keep')).toBe('me');
  });

  it('drops the destination fragment (origin+pathname+search only)', () => {
    const out = buildRedirectUrl(
      'https://x.com/a',
      redirect({ from_url: 'https://x.com/a', to_url: 'https://x.com/b#section' }),
    );
    expect(out).toBe('https://x.com/b');
  });
});

describe('buildRedirectUrl — contains', () => {
  it('string-replaces the first occurrence of from_url with to_url', () => {
    const out = buildRedirectUrl(
      'https://x.com/old/page?q=1',
      redirect({ from_url: '/old', to_url: '/new', url_match_type: 'contains' }),
    );
    expect(out).toBe('https://x.com/new/page?q=1');
  });

  it('only replaces the first occurrence', () => {
    const out = buildRedirectUrl(
      'https://x.com/a/a',
      redirect({ from_url: '/a', to_url: '/b', url_match_type: 'contains' }),
    );
    expect(out).toBe('https://x.com/b/a');
  });
});

describe('buildRedirectUrl — query', () => {
  it('sets query params parsed from to_url, keeping the current URL', () => {
    const out = buildRedirectUrl(
      'https://x.com/p?existing=1',
      redirect({
        from_url: 'https://x.com/p',
        to_url: 'variant=b&flag=on',
        url_match_type: 'query',
      }),
    );
    const url = new URL(out);
    expect(url.pathname).toBe('/p');
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('variant')).toBe('b');
    expect(url.searchParams.get('flag')).toBe('on');
  });

  it('overwrites an existing param with the same key', () => {
    const out = buildRedirectUrl(
      'https://x.com/p?variant=a',
      redirect({ from_url: 'https://x.com/p', to_url: 'variant=b', url_match_type: 'query' }),
    );
    expect(new URL(out).searchParams.get('variant')).toBe('b');
  });
});

describe('buildRedirectUrl — regex', () => {
  it('expands $1/$2 backrefs from the current URL', () => {
    const out = buildRedirectUrl(
      'https://x.com/products/42/red',
      redirect({
        from_url: 'https://x\\.com/products/(\\d+)/(\\w+)',
        to_url: 'https://x.com/p?id=$1&color=$2',
        url_match_type: 'regex',
      }),
    );
    expect(out).toBe('https://x.com/p?id=42&color=red');
  });

  it('expands a missing group to an empty string', () => {
    const out = buildRedirectUrl(
      'https://x.com/products/42',
      redirect({
        from_url: 'https://x\\.com/products/(\\d+)(/extra)?',
        to_url: 'https://x.com/p?id=$1&x=$2',
        url_match_type: 'regex',
      }),
    );
    expect(out).toBe('https://x.com/p?id=42&x=');
  });

  it('sanitizes duplicate ? into a single query separator', () => {
    const out = buildRedirectUrl(
      'https://x.com/a?b',
      redirect({
        from_url: 'https://x\\.com/a\\?(\\w+)',
        to_url: 'https://x.com/dest?first=1?second=$1',
        url_match_type: 'regex',
      }),
    );
    expect(out).toBe('https://x.com/dest?first=1&second=b');
  });
});

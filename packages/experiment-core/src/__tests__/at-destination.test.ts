import { describe, expect, it } from 'vitest';
import { isAtRedirectDestination } from '../redirect/at-destination.ts';
import type { RedirectChange } from '../redirect/decide.ts';

const change = (over: Partial<RedirectChange>): RedirectChange => ({
  type: 'redirect',
  from_url: 'https://acme.com/pricing',
  to_url: 'https://acme.com/pricing-v2',
  ...over,
});

describe('isAtRedirectDestination', () => {
  describe('exact (default)', () => {
    it('recognises the destination, query params and all', () => {
      expect(isAtRedirectDestination(change({}), 'https://acme.com/pricing-v2?utm_source=fb')).toBe(
        true,
      );
    });

    it('tolerates a trailing slash on either side', () => {
      expect(isAtRedirectDestination(change({}), 'https://acme.com/pricing-v2/')).toBe(true);
    });

    it('accepts a relative to_url', () => {
      expect(
        isAtRedirectDestination(change({ to_url: '/pricing-v2' }), 'https://acme.com/pricing-v2'),
      ).toBe(true);
    });

    it('rejects a different path and a different host', () => {
      expect(isAtRedirectDestination(change({}), 'https://acme.com/pricing')).toBe(false);
      expect(isAtRedirectDestination(change({}), 'https://other.com/pricing-v2')).toBe(false);
    });
  });

  describe('contains', () => {
    const c = change({
      url_match_type: 'contains',
      from_url: '/question/male',
      to_url: '/question/female',
    });

    it('recognises the replaced fragment anywhere in the href', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/question/female/1')).toBe(true);
    });

    it('rejects the control url', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/question/male/1')).toBe(false);
    });
  });

  describe('query', () => {
    const c = change({ url_match_type: 'query', to_url: 'variant=b&layout=wide' });

    it('recognises the url once every pair is set', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/pricing?variant=b&layout=wide')).toBe(
        true,
      );
    });

    it('rejects a partial or wrong-valued match', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/pricing?variant=b')).toBe(false);
      expect(isAtRedirectDestination(c, 'https://acme.com/pricing?variant=a&layout=wide')).toBe(
        false,
      );
    });

    it('treats a bare key as an empty value, matching buildQuery', () => {
      expect(
        isAtRedirectDestination(
          change({ url_match_type: 'query', to_url: 'variant' }),
          'https://acme.com/pricing?variant=',
        ),
      ).toBe(true);
    });
  });

  describe('regex — the case that silently dropped the whole variant arm', () => {
    // `to_url` is a TEMPLATE. The captured text is unknowable at the
    // destination, so the old origin+path equality could never be true and the
    // variant produced no exposure anywhere. Match the template's shape instead.
    const c = change({
      url_match_type: 'regex',
      from_url: 'https://acme\\.com/p/(\\d+)/checkout',
      to_url: '/p/$1/checkout-v2',
    });

    it('recognises a url built from the template', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/p/4821/checkout-v2')).toBe(true);
    });

    it('still recognises it with merged query params', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/p/4821/checkout-v2?gclid=x')).toBe(true);
    });

    it('rejects the control url and unrelated pages', () => {
      expect(isAtRedirectDestination(c, 'https://acme.com/p/4821/checkout')).toBe(false);
      expect(isAtRedirectDestination(c, 'https://acme.com/basket')).toBe(false);
    });

    it('handles an absolute template', () => {
      const abs = change({
        url_match_type: 'regex',
        from_url: 'https://acme\\.com/p/(\\d+)',
        to_url: 'https://shop.acme.com/p/$1',
      });
      expect(isAtRedirectDestination(abs, 'https://shop.acme.com/p/4821')).toBe(true);
      expect(isAtRedirectDestination(abs, 'https://acme.com/p/4821')).toBe(false);
    });

    it('does not throw on a template that escapes to an invalid pattern', () => {
      const bad = change({ url_match_type: 'regex', to_url: '/p/[$1' });
      expect(isAtRedirectDestination(bad, 'https://acme.com/p/[9')).toBe(true);
    });
  });

  it('is false when the change carries no destination', () => {
    expect(isAtRedirectDestination(change({ to_url: '' }), 'https://acme.com/x')).toBe(false);
  });
});

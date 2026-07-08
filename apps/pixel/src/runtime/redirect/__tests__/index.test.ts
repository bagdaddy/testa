import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCookies, clearStorages } from '../../../__test-utils__/reset.ts';
import { readBreadcrumbs, __resetForTests as resetBreadcrumbs } from '../breadcrumbs.ts';
import { clearRedirected, markRedirected } from '../dedup.ts';
import { evaluateAndApply } from '../index.ts';

const REDIRECT: Extract<VariationChange, { type: 'redirect' }> = {
  type: 'redirect',
  from_url: 'https://customer.com/a',
  to_url: 'https://customer.com/b',
};

beforeEach(() => {
  clearAllCookies();
  clearStorages();
  resetBreadcrumbs();
});

afterEach(() => {
  resetBreadcrumbs();
});

describe('evaluateAndApply — happy path', () => {
  it('fires when current matches from_url, marks dedup, and logs breadcrumbs', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: REDIRECT,
        currentUrl: 'https://customer.com/a?utm_source=fb',
      },
      navigate,
    );

    expect(out.fired).toBe(true);
    expect(out.reason).toBe('fired');
    expect(out.finalUrl).toBe('https://customer.com/b?utm_source=fb');
    expect(navigate).toHaveBeenCalledWith('https://customer.com/b?utm_source=fb');

    const phases = readBreadcrumbs().map((b) => b.phase);
    expect(phases).toContain('evaluate');
    expect(phases).toContain('match');
    expect(phases).toContain('fired');
  });

  it('preserves utm_* params on the destination', () => {
    const navigate = vi.fn();
    evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: REDIRECT,
        currentUrl: 'https://customer.com/a?utm_source=g&utm_campaign=spring',
      },
      navigate,
    );
    const finalUrl = navigate.mock.calls[0]?.[0] as string;
    const url = new URL(finalUrl);
    expect(url.searchParams.get('utm_source')).toBe('g');
    expect(url.searchParams.get('utm_campaign')).toBe('spring');
  });
});

describe('evaluateAndApply — guards', () => {
  it('does not fire when no_match', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: REDIRECT,
        currentUrl: 'https://customer.com/elsewhere',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('no_match');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not fire when already redirected (dedup)', () => {
    markRedirected(17);
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: REDIRECT,
        currentUrl: 'https://customer.com/a',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('already_redirected');
    expect(navigate).not.toHaveBeenCalled();
    clearRedirected(17);
  });

  it('does not fire when target equals current (after canonicalize)', () => {
    const navigate = vi.fn();
    const change: typeof REDIRECT = {
      type: 'redirect',
      from_url: 'https://customer.com/a',
      to_url: 'https://customer.com/a/?_testa_x=1',
    };
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change,
        currentUrl: 'https://customer.com/a',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('skipped_same_url');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('aborts on missing from_url / to_url', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: { type: 'redirect', from_url: '', to_url: 'https://x.com/b' },
        currentUrl: 'https://customer.com/a',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('aborted_invalid_target');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('fires only once across two evaluations (dedup persists)', () => {
    const navigate = vi.fn();
    const args = {
      experiment_id: 17,
      variation_id: 100,
      change: REDIRECT,
      currentUrl: 'https://customer.com/a',
    };
    evaluateAndApply(args, navigate);
    evaluateAndApply(args, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('logs aborted breadcrumb when navigate throws', () => {
    const navigate = vi.fn(() => {
      throw new Error('navigate failed');
    });
    const out = evaluateAndApply(
      {
        experiment_id: 17,
        variation_id: 100,
        change: REDIRECT,
        currentUrl: 'https://customer.com/a',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('aborted_invalid_target');
    const phases = readBreadcrumbs().map((b) => b.phase);
    expect(phases).toContain('aborted_invalid_target');
  });
});

describe('evaluateAndApply — Next.js-style race', () => {
  it('uses the snapshotted currentUrl and is unaffected by location changes mid-call', () => {
    // Simulate Next.js rewriting URL state mid-flight by mutating
    // location.href via history. We pass a snapshot in `currentUrl` so the
    // evaluator never reads `location` directly during the merge.
    const snapshot = 'https://customer.com/a?utm_source=ad';
    history.pushState({}, '', '/elsewhere?stale=1');

    const navigate = vi.fn();
    evaluateAndApply(
      {
        experiment_id: 19,
        variation_id: 1,
        change: REDIRECT,
        currentUrl: snapshot,
      },
      navigate,
    );

    const finalUrl = navigate.mock.calls[0]?.[0] as string;
    expect(new URL(finalUrl).searchParams.get('utm_source')).toBe('ad');
    expect(new URL(finalUrl).searchParams.has('stale')).toBe(false);
  });
});

describe('evaluateAndApply — url_match_type modes', () => {
  it('contains: string-replaces from_url and fires', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 21,
        variation_id: 1,
        change: {
          type: 'redirect',
          from_url: '/old',
          to_url: '/new',
          url_match_type: 'contains',
        },
        currentUrl: 'https://customer.com/old/page',
      },
      navigate,
    );
    expect(out.fired).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://customer.com/new/page');
  });

  it('contains: no_match when from_url is not a substring of current', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 22,
        variation_id: 1,
        change: {
          type: 'redirect',
          from_url: '/nope',
          to_url: '/new',
          url_match_type: 'contains',
        },
        currentUrl: 'https://customer.com/old/page',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('no_match');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('query: sets/overwrites query params on the current URL and fires', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 23,
        variation_id: 1,
        change: {
          type: 'redirect',
          from_url: 'https://customer.com/p',
          to_url: 'variant=b',
          url_match_type: 'query',
        },
        currentUrl: 'https://customer.com/p?keep=1',
      },
      navigate,
    );
    expect(out.fired).toBe(true);
    const finalUrl = navigate.mock.calls[0]?.[0] as string;
    const url = new URL(finalUrl);
    expect(url.searchParams.get('variant')).toBe('b');
    expect(url.searchParams.get('keep')).toBe('1');
  });

  it('regex: expands $1/$2 backrefs (missing group → empty) and fires', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 24,
        variation_id: 1,
        change: {
          type: 'redirect',
          from_url: 'https://customer\\.com/products/(\\d+)(/extra)?',
          to_url: 'https://customer.com/p?id=$1&x=$2',
          url_match_type: 'regex',
        },
        currentUrl: 'https://customer.com/products/42',
      },
      navigate,
    );
    expect(out.fired).toBe(true);
    expect(navigate).toHaveBeenCalledWith('https://customer.com/p?id=42&x=');
  });

  it('self-redirect no-op: destination equal to current is skipped', () => {
    const navigate = vi.fn();
    const out = evaluateAndApply(
      {
        experiment_id: 25,
        variation_id: 1,
        change: {
          type: 'redirect',
          from_url: '/page',
          to_url: '/page',
          url_match_type: 'contains',
        },
        currentUrl: 'https://customer.com/page',
      },
      navigate,
    );
    expect(out.fired).toBe(false);
    expect(out.reason).toBe('skipped_same_url');
    expect(navigate).not.toHaveBeenCalled();
  });
});

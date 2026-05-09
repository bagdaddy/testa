import type { VariationChange } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBreadcrumbs, __resetForTests as resetBreadcrumbs } from '../breadcrumbs.ts';
import { clearRedirected, markRedirected } from '../dedup.ts';
import { evaluateAndApply } from '../index.ts';

const REDIRECT: Extract<VariationChange, { type: 'redirect' }> = {
  type: 'redirect',
  from_url: 'https://customer.com/a',
  to_url: 'https://customer.com/b',
};

beforeEach(() => {
  if (typeof document !== 'undefined') {
    for (const c of document.cookie.split(';')) {
      const eq = c.indexOf('=');
      const name = (eq < 0 ? c : c.slice(0, eq)).trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
    }
  }
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
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

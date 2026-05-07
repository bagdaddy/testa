import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBOUNCE_MS, LOCATIONCHANGE_EVENT, installSpaHandler } from '../spa.ts';

let uninstall: (() => void) | null = null;

beforeEach(() => {
  // Reset URL state so canonical baseline is consistent.
  window.history.replaceState({}, '', '/');
  vi.useFakeTimers();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

describe('debounce', () => {
  it('coalesces a burst of locationchange events into one transition', () => {
    const onTransition = vi.fn();
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/foo');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    window.history.replaceState({}, '', '/foo?a=1');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    window.history.replaceState({}, '', '/foo?a=1&b=2');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));

    vi.advanceTimersByTime(DEBOUNCE_MS + 5);
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[0]).toContain('/foo');
  });

  it('fires once for popstate and once for hashchange after their own debounce windows', () => {
    const onTransition = vi.fn();
    uninstall = installSpaHandler({ onTransition, includeHash: true });

    window.history.replaceState({}, '', '/foo');
    window.dispatchEvent(new PopStateEvent('popstate'));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    window.history.replaceState({}, '', '/foo#x');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).toHaveBeenCalledTimes(2);
  });
});

describe('canonical URL diff', () => {
  it('does NOT fire when only _testa_* / _tu params change', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo?id=42');
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/foo?id=42&_tu=abc&_testa_cd=xyz');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).not.toHaveBeenCalled();
  });

  it('does NOT fire when same-URL pushState (state-only update) runs', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo?a=1');
    uninstall = installSpaHandler({ onTransition });

    // pushState with the same URL — frameworks do this to update state.
    window.history.pushState({ updated: true }, '', '/foo?a=1');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).not.toHaveBeenCalled();
  });

  it('DOES fire when the path actually changes', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/bar');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it('DOES fire when a non-_testa query param changes', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo?id=1');
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/foo?id=2');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it('hashchange does NOT fire onTransition when includeHash=false (default)', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/foo#section-2');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).not.toHaveBeenCalled();
  });

  it('hashchange DOES fire when includeHash=true', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition, includeHash: true });

    window.history.replaceState({}, '', '/foo#section-2');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).toHaveBeenCalledTimes(1);
  });
});

describe('robustness', () => {
  it('a throwing onTransition does not break the listener for future events', () => {
    const onTransition = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('cycle exploded');
      })
      .mockImplementation(() => {});

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition });

    window.history.replaceState({}, '', '/bar');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    window.history.replaceState({}, '', '/baz');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('uninstall stops further events from firing', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition });
    uninstall();
    uninstall = null;

    window.history.replaceState({}, '', '/bar');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    expect(onTransition).not.toHaveBeenCalled();
  });
});

describe('debug ring', () => {
  it('records each debounced cycle (including same-canonical drops)', () => {
    const onTransition = vi.fn();
    window.history.replaceState({}, '', '/foo');
    uninstall = installSpaHandler({ onTransition });

    // Real change.
    window.history.replaceState({}, '', '/bar');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    // Same-canonical (just _tu added).
    window.history.replaceState({}, '', '/bar?_tu=abc');
    window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
    vi.advanceTimersByTime(DEBOUNCE_MS + 5);

    const debug = window.__testa_spa_debug;
    expect(debug?.ring.length).toBe(2);
    expect(debug?.ring[1]?.sameCanonical).toBe(true);
  });
});

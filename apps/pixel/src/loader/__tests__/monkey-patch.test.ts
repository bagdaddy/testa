import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCATIONCHANGE_EVENT, PATCH_FLAG, installMonkeyPatch } from '../monkey-patch.ts';

// Snapshot the originals once; reset for each test.
const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

beforeEach(() => {
  (window as unknown as Record<string, unknown>)[PATCH_FLAG] = undefined;
  // Restore native methods so we patch a clean slate.
  Object.defineProperty(history, 'pushState', {
    value: originalPushState,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(history, 'replaceState', {
    value: originalReplaceState,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('installMonkeyPatch — basic install', () => {
  it('marks the window as patched', () => {
    installMonkeyPatch();
    expect((window as unknown as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]).toBe(true);
  });

  it('is idempotent — second call is a no-op', () => {
    installMonkeyPatch();
    const wrappedFirst = history.pushState;
    installMonkeyPatch();
    expect(history.pushState).toBe(wrappedFirst);
  });
});

describe('pushState dispatches _testa:locationchange', () => {
  it('fires the event AFTER the original returns (microtask ordering)', async () => {
    installMonkeyPatch();

    const eventOrder: string[] = [];
    window.addEventListener(LOCATIONCHANGE_EVENT, () => {
      eventOrder.push('event');
    });

    history.pushState({}, '', '/foo');
    eventOrder.push('after-call');

    await flushMicrotasks();

    // The synchronous `after-call` push runs before the microtask-scheduled event.
    expect(eventOrder).toEqual(['after-call', 'event']);
  });

  it('original pushState is still called (URL actually changes)', () => {
    installMonkeyPatch();
    history.pushState({}, '', '/changed');
    expect(window.location.pathname).toBe('/changed');
  });

  it('replaceState also dispatches the event', async () => {
    installMonkeyPatch();
    const handler = vi.fn();
    window.addEventListener(LOCATIONCHANGE_EVENT, handler);
    history.replaceState({}, '', '/replaced');
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('popstate / hashchange listeners', () => {
  it('popstate dispatches the locationchange event', () => {
    installMonkeyPatch();
    const handler = vi.fn();
    window.addEventListener(LOCATIONCHANGE_EVENT, handler);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hashchange dispatches the locationchange event', () => {
    installMonkeyPatch();
    const handler = vi.fn();
    window.addEventListener(LOCATIONCHANGE_EVENT, handler);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('bfcache pageshow re-install', () => {
  it('re-installs the patch if pageshow fires after the patch flag was cleared', async () => {
    installMonkeyPatch();
    expect((window as unknown as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]).toBe(true);

    // Simulate bfcache restoring the original pushState — clear the flag and
    // overwrite history.pushState with the native ref.
    (window as unknown as { [PATCH_FLAG]?: boolean })[PATCH_FLAG] = false;
    Object.defineProperty(history, 'pushState', {
      value: originalPushState,
      writable: true,
      configurable: true,
    });

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

    expect((window as unknown as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]).toBe(true);

    const handler = vi.fn();
    window.addEventListener(LOCATIONCHANGE_EVENT, handler);
    history.pushState({}, '', '/post-bfcache');
    await flushMicrotasks();
    expect(handler).toHaveBeenCalled();
  });
});

describe('framework wrap order — wrapping preserves our event', () => {
  it('a framework that patches AFTER us still triggers our event because we run the original first', async () => {
    installMonkeyPatch();

    // Simulate Next.js / React Router patching pushState after we have.
    const ourWrapped = history.pushState.bind(history);
    let frameworkCalled = false;
    const frameworkWrapper = function (this: History, ...args: Parameters<History['pushState']>) {
      frameworkCalled = true;
      return ourWrapped(...args);
    };
    Object.defineProperty(history, 'pushState', {
      value: frameworkWrapper,
      writable: true,
      configurable: true,
    });

    const handler = vi.fn();
    window.addEventListener(LOCATIONCHANGE_EVENT, handler);
    history.pushState({}, '', '/with-framework');
    await flushMicrotasks();

    expect(frameworkCalled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

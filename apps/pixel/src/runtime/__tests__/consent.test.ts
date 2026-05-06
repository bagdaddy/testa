import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMP_EVENT, DEFAULT_STATE, consent, installCmpListener } from '../consent.ts';

beforeEach(() => {
  consent.__resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('default state', () => {
  it('starts at "granted" (matches GA4 default)', () => {
    expect(consent.getState()).toBe('granted');
    expect(DEFAULT_STATE).toBe('granted');
  });

  it('is not held by default', () => {
    expect(consent.isHeld()).toBe(false);
  });
});

describe('setState', () => {
  it('flips between valid states', () => {
    consent.setState('denied');
    expect(consent.getState()).toBe('denied');
    consent.setState('unknown');
    expect(consent.getState()).toBe('unknown');
    consent.setState('granted');
    expect(consent.getState()).toBe('granted');
  });

  it('ignores invalid values silently', () => {
    consent.setState('granted');
    consent.setState('bogus' as never);
    expect(consent.getState()).toBe('granted');
  });

  it('is a no-op when value matches current state', () => {
    const handler = vi.fn();
    consent.subscribe(handler);
    consent.setState('granted'); // already granted
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('subscribe', () => {
  it('notifies subscribers on transition', () => {
    const handler = vi.fn();
    consent.subscribe(handler);
    consent.setState('denied');
    expect(handler).toHaveBeenCalledWith('denied');
  });

  it('returns an unsubscribe function', () => {
    const handler = vi.fn();
    const off = consent.subscribe(handler);
    off();
    consent.setState('denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not crash when a subscriber throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consent.subscribe(() => {
      throw new Error('boom');
    });
    const next = vi.fn();
    consent.subscribe(next);

    expect(() => consent.setState('denied')).not.toThrow();
    expect(next).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('multiple subscribers all fire', () => {
    const a = vi.fn();
    const b = vi.fn();
    consent.subscribe(a);
    consent.subscribe(b);
    consent.setState('denied');
    expect(a).toHaveBeenCalledWith('denied');
    expect(b).toHaveBeenCalledWith('denied');
  });
});

describe('strict mode hold/release', () => {
  it('holds when strict + not granted', () => {
    consent.setStrictMode(true);
    consent.setState('unknown');
    expect(consent.isHeld()).toBe(true);
  });

  it('does not hold when strict + granted', () => {
    consent.setStrictMode(true);
    consent.setState('granted');
    expect(consent.isHeld()).toBe(false);
  });

  it('whenAllowed resolves immediately when not held', async () => {
    consent.setStrictMode(true);
    consent.setState('granted');
    let resolved = false;
    await consent.whenAllowed().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it('whenAllowed pends until granted under strict mode', async () => {
    consent.setStrictMode(true);
    consent.setState('unknown');

    let resolved = false;
    const p = consent.whenAllowed().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    consent.setState('granted');
    await p;
    expect(resolved).toBe(true);
  });

  it('multiple whenAllowed callers all resolve on grant', async () => {
    consent.setStrictMode(true);
    consent.setState('unknown');

    const a = consent.whenAllowed();
    const b = consent.whenAllowed();
    consent.setState('granted');
    await Promise.all([a, b]);
  });

  it('flipping strict mode off releases held callers', async () => {
    consent.setStrictMode(true);
    consent.setState('unknown');
    const p = consent.whenAllowed();
    consent.setStrictMode(false);
    await p;
  });
});

describe('cmp:consent-changed listener', () => {
  it('flips state when CustomEvent fires with valid detail', () => {
    installCmpListener();
    window.dispatchEvent(new CustomEvent(CMP_EVENT, { detail: 'denied' }));
    expect(consent.getState()).toBe('denied');
  });

  it('ignores invalid detail values', () => {
    installCmpListener();
    consent.setState('granted');
    window.dispatchEvent(new CustomEvent(CMP_EVENT, { detail: 'bogus' }));
    expect(consent.getState()).toBe('granted');
  });

  it('ignores non-string detail', () => {
    installCmpListener();
    consent.setState('granted');
    window.dispatchEvent(new CustomEvent(CMP_EVENT, { detail: { state: 'denied' } }));
    expect(consent.getState()).toBe('granted');
  });

  it('installCmpListener is idempotent', () => {
    installCmpListener();
    installCmpListener();
    const handler = vi.fn();
    consent.subscribe(handler);
    window.dispatchEvent(new CustomEvent(CMP_EVENT, { detail: 'denied' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

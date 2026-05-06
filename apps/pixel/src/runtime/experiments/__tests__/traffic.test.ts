import { beforeEach, describe, expect, it } from 'vitest';
import * as cookies from '../../cookies.ts';
import { type Experiment, assign, bucketOf, recordExposure } from '../traffic.ts';

beforeEach(() => {
  // happy-dom shares document.cookie + storage between tests; reset.
  for (const c of document.cookie.split(';')) {
    const eq = c.indexOf('=');
    const name = (eq < 0 ? c : c.slice(0, eq)).trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
    }
  }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore
  }
});

function fiftyFifty(): Experiment {
  return {
    experiment_id: 17,
    traffic_allocation: 100,
    variations: [
      { variation_id: 100, weight: 50 },
      { variation_id: 200, weight: 50 },
    ],
  };
}

describe('bucketOf', () => {
  it('returns an integer 0..99', () => {
    for (let i = 0; i < 100; i++) {
      const b = bucketOf(`visitor_${i}`, 17);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('is deterministic for the same (visitor, experiment) pair', () => {
    expect(bucketOf('alice', 17)).toBe(bucketOf('alice', 17));
  });

  it('changes with experimentId', () => {
    expect(bucketOf('alice', 17)).not.toBe(bucketOf('alice', 18));
  });
});

describe('assign — happy path', () => {
  it('assigns a variation, persists the cookie', () => {
    const r = assign(fiftyFifty(), { visitorId: 'alice' });
    expect(r.isExcluded).toBe(false);
    expect([100, 200]).toContain(r.variationId);
    expect(cookies.getAssignment(17)).toBe(r.variationId);
  });

  it('cookie-first lookup: returns cached variation without rebucketing', () => {
    cookies.setAssignment(17, 100);
    const r = assign(fiftyFifty(), { visitorId: 'whoever' });
    expect(r.variationId).toBe(100);
    expect(r.isExcluded).toBe(false);
  });

  it('cached variation that no longer exists triggers re-bucketing', () => {
    cookies.setAssignment(17, 999); // not in current variations list
    const r = assign(fiftyFifty(), { visitorId: 'alice' });
    expect([100, 200]).toContain(r.variationId);
    expect(cookies.getAssignment(17)).toBe(r.variationId);
  });

  it('returns excluded when no variations are configured', () => {
    const r = assign(
      { experiment_id: 17, traffic_allocation: 100, variations: [] },
      { visitorId: 'alice' },
    );
    expect(r.isExcluded).toBe(true);
    expect(r.excludedReason).toBe('no_variations');
  });
});

describe('assign — traffic allocation', () => {
  it('partial allocation excludes some visitors', () => {
    const exp: Experiment = {
      ...fiftyFifty(),
      traffic_allocation: 50,
    };
    let included = 0;
    for (let i = 0; i < 1000; i++) {
      // Reset the cookie store between iterations so cache doesn't dominate.
      cookies.clearExperiment(17);
      const r = assign(exp, { visitorId: `visitor_${i}` });
      if (!r.isExcluded) included += 1;
    }
    // 50% allocation × 1000 visitors → expect 500 ± ~50 (3σ for binom(1000, 0.5))
    expect(included).toBeGreaterThan(400);
    expect(included).toBeLessThan(600);
  });

  it('0% traffic excludes everyone', () => {
    const exp: Experiment = { ...fiftyFifty(), traffic_allocation: 0 };
    const r = assign(exp, { visitorId: 'alice' });
    expect(r.isExcluded).toBe(true);
    expect(r.excludedReason).toBe('traffic_allocation');
  });
});

describe('assign — distribution check', () => {
  it('50/50 weights distribute roughly evenly across 10k visitors', () => {
    const exp = fiftyFifty();
    let v100 = 0;
    let v200 = 0;
    for (let i = 0; i < 10_000; i++) {
      cookies.clearExperiment(17);
      const r = assign(exp, { visitorId: `visitor_${i}` });
      if (r.variationId === 100) v100++;
      else if (r.variationId === 200) v200++;
    }
    // Within 3σ of 5000 each → ±150-ish.
    expect(v100).toBeGreaterThan(4700);
    expect(v100).toBeLessThan(5300);
    expect(v200).toBeGreaterThan(4700);
    expect(v200).toBeLessThan(5300);
  });
});

describe('assign — mutex group', () => {
  it('blocks enrollment when another experiment holds the group', () => {
    cookies.setMutex('checkout', 99); // some other experiment owns it
    const exp: Experiment = { ...fiftyFifty(), mutex_group: 'checkout' };
    const r = assign(exp, { visitorId: 'alice' });
    expect(r.isExcluded).toBe(true);
    expect(r.excludedReason).toBe('mutex_group_collision');
  });

  it('allows enrollment when this experiment already holds the group', () => {
    cookies.setMutex('checkout', 17); // same experiment
    const exp: Experiment = { ...fiftyFifty(), mutex_group: 'checkout' };
    const r = assign(exp, { visitorId: 'alice' });
    expect(r.isExcluded).toBe(false);
  });

  it('acquires the mutex on first successful enrollment', () => {
    const exp: Experiment = { ...fiftyFifty(), mutex_group: 'checkout' };
    assign(exp, { visitorId: 'alice' });
    expect(cookies.getMutex('checkout')).toBe(17);
  });
});

describe('assign — frequency cap', () => {
  it('blocks enrollment when count >= max within the window', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'week' },
    };
    cookies.setFreq(17, { count: 3, window_start_ts: now - 60_000 }, 7 * 86400);
    cookies.clearAssignment(17); // force the freq guard to trigger before bucketing
    const r = assign(exp, { visitorId: 'alice', now });
    expect(r.isExcluded).toBe(true);
    expect(r.excludedReason).toBe('frequency_cap_exhausted');
  });

  it('allows enrollment when count < max', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'week' },
    };
    cookies.setFreq(17, { count: 1, window_start_ts: now - 60_000 }, 7 * 86400);
    const r = assign(exp, { visitorId: 'alice', now });
    expect(r.isExcluded).toBe(false);
  });

  it('allows enrollment when window has elapsed (counter is stale)', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'day' },
    };
    cookies.setFreq(17, { count: 999, window_start_ts: now - 2 * 86_400_000 }, 86400);
    cookies.clearAssignment(17);
    const r = assign(exp, { visitorId: 'alice', now });
    expect(r.isExcluded).toBe(false);
  });
});

describe('recordExposure', () => {
  it('initializes counter to {count:1, window_start_ts:now} on first call', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'week' },
    };
    recordExposure(exp, now);
    expect(cookies.getFreq(17)).toEqual({ count: 1, window_start_ts: now });
  });

  it('increments within an active window', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'week' },
    };
    recordExposure(exp, now);
    recordExposure(exp, now + 60_000);
    expect(cookies.getFreq(17)).toEqual({ count: 2, window_start_ts: now });
  });

  it('resets the window when the previous one has elapsed', () => {
    const now = 1_700_000_000_000;
    const exp: Experiment = {
      ...fiftyFifty(),
      frequency_cap: { max: 3, window: 'day' },
    };
    cookies.setFreq(17, { count: 5, window_start_ts: now - 2 * 86_400_000 }, 86400);
    recordExposure(exp, now);
    expect(cookies.getFreq(17)).toEqual({ count: 1, window_start_ts: now });
  });

  it('is a no-op for experiments without frequency_cap', () => {
    recordExposure(fiftyFifty());
    expect(cookies.getFreq(17)).toBeNull();
  });
});

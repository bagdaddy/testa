import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIGNMENT_TTL_SEC,
  SESSION_LENGTH_SEC,
  UUID_COOKIE,
  assignmentName,
  bumpSession,
  clearAssignment,
  clearExperiment,
  clearFreq,
  clearMutex,
  exclusionName,
  firstSeenName,
  freqName,
  getAssignment,
  getExclusion,
  getFirstSeen,
  getFreq,
  getMutex,
  getSession,
  getUuid,
  mutexName,
  sessionName,
  setAssignment,
  setExclusion,
  setFirstSeen,
  setFreq,
  setMutex,
} from '../cookies.ts';

beforeEach(() => {
  // happy-dom shares document.cookie + localStorage between tests; reset.
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
    // ignore in environments without storage
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('name builders', () => {
  it('build canonical names with experiment id suffixes', () => {
    expect(assignmentName(17)).toBe('_testa_exp_17');
    expect(sessionName(17)).toBe('_testa_ses_17');
    expect(exclusionName(17)).toBe('_testa_excl_17');
    expect(firstSeenName(17)).toBe('_testa_user_17');
    expect(freqName(17)).toBe('_testa_freq_17');
    expect(mutexName('checkout')).toBe('_testa_mutex_checkout');
  });
});

describe('uuid (read-only from JS perspective)', () => {
  it('returns null when no cookie set', () => {
    expect(getUuid()).toBeNull();
  });

  it('reads the worker-set value', () => {
    document.cookie = `${UUID_COOKIE}=01923a4f-7000-7d9c-bb8f-1234567890ab; path=/`;
    expect(getUuid()).toBe('01923a4f-7000-7d9c-bb8f-1234567890ab');
  });
});

describe('per-experiment assignment', () => {
  it('round-trips assignment id', () => {
    setAssignment(17, 100);
    expect(getAssignment(17)).toBe(100);
  });

  it('returns null when not set', () => {
    expect(getAssignment(17)).toBeNull();
  });

  it('clearAssignment removes the value', () => {
    setAssignment(17, 100);
    clearAssignment(17);
    expect(getAssignment(17)).toBeNull();
  });

  it('isolates by experiment id', () => {
    setAssignment(17, 100);
    setAssignment(42, 999);
    expect(getAssignment(17)).toBe(100);
    expect(getAssignment(42)).toBe(999);
  });

  it('returns null for malformed value', () => {
    document.cookie = '_testa_exp_17=not-a-number; path=/';
    localStorage.removeItem('_testa_exp_17');
    expect(getAssignment(17)).toBeNull();
  });
});

describe('session', () => {
  it('bumpSession writes the current timestamp', () => {
    const before = Date.now();
    bumpSession(17);
    const after = Date.now();
    const stored = getSession(17);
    expect(stored).not.toBeNull();
    if (stored !== null) {
      expect(stored).toBeGreaterThanOrEqual(before);
      expect(stored).toBeLessThanOrEqual(after);
    }
  });

  it('returns null when absent', () => {
    expect(getSession(17)).toBeNull();
  });
});

describe('exclusion', () => {
  it('round-trips boolean as 0/1', () => {
    setExclusion(17, true);
    expect(getExclusion(17)).toBe(true);
    setExclusion(17, false);
    expect(getExclusion(17)).toBe(false);
  });

  it('returns false when absent', () => {
    expect(getExclusion(17)).toBe(false);
  });
});

describe('first-seen', () => {
  it('round-trips a numeric timestamp', () => {
    setFirstSeen(17, 1_700_000_000_000);
    expect(getFirstSeen(17)).toBe(1_700_000_000_000);
  });

  it('returns null when absent', () => {
    expect(getFirstSeen(17)).toBeNull();
  });
});

describe('frequency cap', () => {
  it('round-trips the FreqCounter shape', () => {
    setFreq(17, { count: 2, window_start_ts: 1_700_000_000_000 }, 7 * 86400);
    expect(getFreq(17)).toEqual({
      count: 2,
      window_start_ts: 1_700_000_000_000,
    });
  });

  it('returns null when absent', () => {
    expect(getFreq(17)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    document.cookie = '_testa_freq_17=not-json; path=/';
    localStorage.removeItem('_testa_freq_17');
    expect(getFreq(17)).toBeNull();
  });

  it('returns null when fields are wrong type', () => {
    document.cookie = `_testa_freq_17=${encodeURIComponent('{"count":"two","window_start_ts":1700000000000}')}; path=/`;
    localStorage.removeItem('_testa_freq_17');
    expect(getFreq(17)).toBeNull();
  });

  it('clearFreq removes the value', () => {
    setFreq(17, { count: 1, window_start_ts: 1 }, 60);
    clearFreq(17);
    expect(getFreq(17)).toBeNull();
  });
});

describe('mutex group', () => {
  it('round-trips an experiment_id by group name', () => {
    setMutex('checkout_optimization', 42);
    expect(getMutex('checkout_optimization')).toBe(42);
  });

  it('returns null when absent', () => {
    expect(getMutex('foo')).toBeNull();
  });

  it('isolates groups', () => {
    setMutex('a', 1);
    setMutex('b', 2);
    expect(getMutex('a')).toBe(1);
    expect(getMutex('b')).toBe(2);
  });

  it('clearMutex removes the value', () => {
    setMutex('a', 1);
    clearMutex('a');
    expect(getMutex('a')).toBeNull();
  });
});

describe('clearExperiment', () => {
  it('wipes all per-experiment cookies for the given id', () => {
    setAssignment(17, 100);
    setExclusion(17, true);
    setFirstSeen(17, 123);
    setFreq(17, { count: 1, window_start_ts: 1 }, 60);
    bumpSession(17);

    clearExperiment(17);

    expect(getAssignment(17)).toBeNull();
    expect(getExclusion(17)).toBe(false);
    expect(getFirstSeen(17)).toBeNull();
    expect(getFreq(17)).toBeNull();
    expect(getSession(17)).toBeNull();
  });

  it('does NOT touch the uuid cookie', () => {
    document.cookie = `${UUID_COOKIE}=keep-me; path=/`;
    setAssignment(17, 100);
    clearExperiment(17);
    expect(getUuid()).toBe('keep-me');
  });
});

describe('localStorage mirror — survives ITP-style cookie eviction', () => {
  it('reads from localStorage when document.cookie has been wiped', () => {
    setAssignment(17, 100);
    // Simulate Safari ITP wiping the cookie after 7 days
    document.cookie = '_testa_exp_17=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
    expect(getAssignment(17)).toBe(100);
  });
});

describe('TTL sanity', () => {
  it('SESSION_LENGTH_SEC is 1 hour', () => {
    expect(SESSION_LENGTH_SEC).toBe(3600);
  });

  it('ASSIGNMENT_TTL_SEC is 30 days', () => {
    expect(ASSIGNMENT_TTL_SEC).toBe(30 * 86400);
  });
});

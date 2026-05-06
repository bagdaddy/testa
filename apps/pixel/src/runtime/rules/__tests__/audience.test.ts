import type { AudienceCondition } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { type EvalContext, evaluate } from '../audience.ts';

const FIXED_NOW = Date.parse('2026-05-07T18:30:00Z'); // 18:30 UTC, Thursday

function ctx(overrides?: DeepPartial<EvalContext>): EvalContext {
  const base: EvalContext = {
    page: {
      url: 'https://store.example.com/products/widget?utm_source=google&id=42',
      referrer: 'https://google.com/search?q=widget',
    },
    visitor: {
      isReturning: false,
      cookies: new Map(),
      dataLayer: { user: { tier: 'premium', orderCount: 5 } },
    },
    geo: { country: 'US', region: 'CA' },
    device: {
      type: 'desktop',
      browser: 'Chrome',
      os: 'macOS',
      viewportWidth: 1440,
      language: 'en-US',
    },
    now: FIXED_NOW,
    experiments: new Map(),
  };
  return mergeDeep(base, overrides ?? {});
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function mergeDeep<T>(base: T, overrides: DeepPartial<T>): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || base instanceof Map) {
    return (overrides as T) ?? base;
  }
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    const cur = out[k];
    if (
      v !== undefined &&
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      !(v instanceof Map) &&
      cur !== null &&
      typeof cur === 'object' &&
      !(cur instanceof Map)
    ) {
      out[k] = mergeDeep(cur, v as Partial<unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ─── boolean composition ───────────────────────────────────────────────────

describe('boolean composition', () => {
  it('all: every child must be true', () => {
    const c: AudienceCondition = {
      all: [
        { fact: 'geo.country', op: 'in', value: ['US'] },
        { fact: 'device.type', op: 'in', value: ['desktop'] },
      ],
    };
    expect(evaluate(c, ctx())).toBe(true);
    expect(evaluate(c, ctx({ device: { type: 'mobile' } }))).toBe(false);
  });

  it('any: at least one child must be true', () => {
    const c: AudienceCondition = {
      any: [
        { fact: 'geo.country', op: 'in', value: ['DE'] },
        { fact: 'device.type', op: 'in', value: ['desktop'] },
      ],
    };
    expect(evaluate(c, ctx())).toBe(true);
    expect(evaluate(c, ctx({ geo: { country: 'FR' }, device: { type: 'mobile' } }))).toBe(false);
  });

  it('not: inverts', () => {
    const c: AudienceCondition = {
      not: { fact: 'geo.country', op: 'in', value: ['DE'] },
    };
    expect(evaluate(c, ctx())).toBe(true);
    expect(evaluate(c, ctx({ geo: { country: 'DE' } }))).toBe(false);
  });

  it('nested: (country=US AND mobile) OR (country=DE AND desktop)', () => {
    const c: AudienceCondition = {
      any: [
        {
          all: [
            { fact: 'geo.country', op: 'in', value: ['US'] },
            { fact: 'device.type', op: 'in', value: ['mobile'] },
          ],
        },
        {
          all: [
            { fact: 'geo.country', op: 'in', value: ['DE'] },
            { fact: 'device.type', op: 'in', value: ['desktop'] },
          ],
        },
      ],
    };
    expect(evaluate(c, ctx({ device: { type: 'mobile' } }))).toBe(true);
    expect(evaluate(c, ctx({ geo: { country: 'DE' }, device: { type: 'desktop' } }))).toBe(true);
    expect(evaluate(c, ctx())).toBe(false); // US + desktop matches neither
  });
});

// ─── page.* leaves ─────────────────────────────────────────────────────────

describe('page.url', () => {
  it.each([
    ['exact', 'https://store.example.com/products/widget?utm_source=google&id=42', true],
    ['contains', '/products/', true],
    ['notContains', '/checkout/', true],
    ['regex', '^https://store\\.example\\.com', true],
    ['startsWith', 'https://store', true],
    ['endsWith', '&id=42', true],
  ] as const)('op=%s value=%s → %s', (op, value, expected) => {
    expect(evaluate({ fact: 'page.url', op, value }, ctx())).toBe(expected);
  });
});

describe('page.queryParam', () => {
  it('equals match on present param', () => {
    expect(
      evaluate(
        { fact: 'page.queryParam', op: 'equals', key: 'utm_source', value: 'google' },
        ctx(),
      ),
    ).toBe(true);
  });

  it('exists / notExists checks', () => {
    expect(evaluate({ fact: 'page.queryParam', op: 'exists', key: 'id', value: '' }, ctx())).toBe(
      true,
    );
    expect(
      evaluate({ fact: 'page.queryParam', op: 'notExists', key: 'missing', value: '' }, ctx()),
    ).toBe(true);
  });
});

describe('page.referrer', () => {
  it('matches via UrlOp ops', () => {
    expect(evaluate({ fact: 'page.referrer', op: 'contains', value: 'google.com' }, ctx())).toBe(
      true,
    );
  });
});

// ─── visitor.* leaves ──────────────────────────────────────────────────────

describe('visitor.cookie', () => {
  it('matches when cookie present', () => {
    expect(
      evaluate(
        { fact: 'visitor.cookie', op: 'equals', key: 'plan', value: 'pro' },
        ctx({ visitor: { cookies: new Map([['plan', 'pro']]) } }),
      ),
    ).toBe(true);
  });

  it('notExists when cookie absent', () => {
    expect(
      evaluate({ fact: 'visitor.cookie', op: 'notExists', key: 'plan', value: '' }, ctx()),
    ).toBe(true);
  });
});

describe('visitor.isReturning', () => {
  it('matches first-time visitors', () => {
    expect(evaluate({ fact: 'visitor.isReturning', op: 'is', value: false }, ctx())).toBe(true);
  });

  it('matches returning visitors', () => {
    expect(
      evaluate(
        { fact: 'visitor.isReturning', op: 'is', value: true },
        ctx({ visitor: { isReturning: true } }),
      ),
    ).toBe(true);
  });
});

describe('visitor.dataLayer', () => {
  it('walks dotted path and matches by string equality', () => {
    expect(
      evaluate(
        { fact: 'visitor.dataLayer', op: 'equals', path: 'user.tier', value: 'premium' },
        ctx(),
      ),
    ).toBe(true);
  });

  it('coerces non-string values to string for comparison', () => {
    expect(
      evaluate(
        { fact: 'visitor.dataLayer', op: 'equals', path: 'user.orderCount', value: '5' },
        ctx(),
      ),
    ).toBe(true);
  });

  it('notExists when path absent', () => {
    expect(
      evaluate(
        { fact: 'visitor.dataLayer', op: 'notExists', path: 'user.missing', value: '' },
        ctx(),
      ),
    ).toBe(true);
  });
});

describe('visitor.custom (deferred)', () => {
  it('returns false until crobot ships the AST compiler', () => {
    expect(evaluate({ fact: 'visitor.custom', op: 'truthy', js: 'whatever' }, ctx())).toBe(false);
  });
});

// ─── geo.* leaves ──────────────────────────────────────────────────────────

describe('geo.country / geo.region', () => {
  it('in / notIn', () => {
    expect(evaluate({ fact: 'geo.country', op: 'in', value: ['US', 'CA'] }, ctx())).toBe(true);
    expect(evaluate({ fact: 'geo.country', op: 'notIn', value: ['DE', 'FR'] }, ctx())).toBe(true);
    expect(evaluate({ fact: 'geo.region', op: 'in', value: ['CA', 'NY'] }, ctx())).toBe(true);
  });
});

// ─── device.* leaves ───────────────────────────────────────────────────────

describe('device.* leaves', () => {
  it('device.type', () => {
    expect(evaluate({ fact: 'device.type', op: 'in', value: ['desktop'] }, ctx())).toBe(true);
  });

  it('device.browser / os / language', () => {
    expect(evaluate({ fact: 'device.browser', op: 'in', value: ['Chrome'] }, ctx())).toBe(true);
    expect(evaluate({ fact: 'device.os', op: 'in', value: ['macOS'] }, ctx())).toBe(true);
    expect(evaluate({ fact: 'device.language', op: 'contains', value: 'en' }, ctx())).toBe(true);
  });

  it('device.viewportWidth: between with max', () => {
    expect(
      evaluate({ fact: 'device.viewportWidth', op: 'between', value: 1024, max: 1920 }, ctx()),
    ).toBe(true);
    expect(evaluate({ fact: 'device.viewportWidth', op: 'lt', value: 1500 }, ctx())).toBe(true);
  });
});

// ─── time.* leaves ─────────────────────────────────────────────────────────

describe('time.* leaves', () => {
  it('hourOfDay matches with tz adjustment', () => {
    // 18:30 UTC = 11:30 in America/Los_Angeles
    expect(
      evaluate({ fact: 'time.hourOfDay', op: 'in', value: [11], tz: 'America/Los_Angeles' }, ctx()),
    ).toBe(true);
  });

  it('dayOfWeek (Thursday = 4)', () => {
    expect(evaluate({ fact: 'time.dayOfWeek', op: 'in', value: [4], tz: 'UTC' }, ctx())).toBe(true);
  });

  it('time.window: inside ISO range', () => {
    expect(
      evaluate(
        {
          fact: 'time.window',
          op: 'between',
          from: '2026-05-07T00:00:00Z',
          to: '2026-05-08T00:00:00Z',
          tz: 'UTC',
        },
        ctx(),
      ),
    ).toBe(true);
  });

  it('time.window: outside range → false', () => {
    expect(
      evaluate(
        {
          fact: 'time.window',
          op: 'between',
          from: '2026-06-01T00:00:00Z',
          to: '2026-06-02T00:00:00Z',
          tz: 'UTC',
        },
        ctx(),
      ),
    ).toBe(false);
  });
});

// ─── experiment.assignedTo ─────────────────────────────────────────────────

describe('experiment.assignedTo', () => {
  it('matches when visitor is in the experiment', () => {
    expect(
      evaluate(
        { fact: 'experiment.assignedTo', op: 'is', experimentId: 17 },
        ctx({ experiments: new Map([[17, 100]]) }),
      ),
    ).toBe(true);
  });

  it('matches a specific variation', () => {
    expect(
      evaluate(
        { fact: 'experiment.assignedTo', op: 'is', experimentId: 17, variationId: 100 },
        ctx({ experiments: new Map([[17, 100]]) }),
      ),
    ).toBe(true);
    expect(
      evaluate(
        { fact: 'experiment.assignedTo', op: 'is', experimentId: 17, variationId: 200 },
        ctx({ experiments: new Map([[17, 100]]) }),
      ),
    ).toBe(false);
  });

  it('isNot inverts', () => {
    expect(evaluate({ fact: 'experiment.assignedTo', op: 'isNot', experimentId: 17 }, ctx())).toBe(
      true,
    );
  });
});

// ─── safety / robustness ──────────────────────────────────────────────────

describe('robustness', () => {
  it('regex with malformed pattern fails closed (no exception)', () => {
    expect(evaluate({ fact: 'page.url', op: 'regex', value: '[unclosed' }, ctx())).toBe(false);
  });

  it('time.window with malformed ISO fails closed', () => {
    expect(
      evaluate(
        { fact: 'time.window', op: 'between', from: 'not-a-date', to: 'also-bad', tz: 'UTC' },
        ctx(),
      ),
    ).toBe(false);
  });
});

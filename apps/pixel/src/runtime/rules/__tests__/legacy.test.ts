import { describe, expect, it } from 'vitest';
import {
  type LegacyExclusion,
  type LegacyExclusionContext,
  type LegacyRule,
  type LegacyTargetingContext,
  evaluateLegacyExclusions,
  evaluateLegacyTargeting,
} from '../legacy.ts';

// ─── targeting fixtures ──────────────────────────────────────────────────────

function targetingCtx(overrides?: Partial<LegacyTargetingContext>): LegacyTargetingContext {
  return {
    queryParams: new Map([
      ['utm_source', 'google'],
      ['plan', 'pro'],
    ]),
    geo: { country: 'US', region: 'CA' },
    device: { isMobile: false, isTablet: false, isDesktop: true },
    ...overrides,
  };
}

// ─── targeting: URL parameter operators ──────────────────────────────────────

describe('evaluateLegacyTargeting — url param operators', () => {
  it('equals passes when the param matches', () => {
    const rules: LegacyRule[] = [{ type: 'utm_source', operator: 'equals', value: 'google' }];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(true);
  });

  it('equals fails when the param is absent', () => {
    const rules: LegacyRule[] = [{ type: 'missing', operator: 'equals', value: 'x' }];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(false);
  });

  it('not_equals passes for an absent param (value !== null)', () => {
    const rules: LegacyRule[] = [{ type: 'missing', operator: 'not_equals', value: 'x' }];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(true);
  });

  it('contains passes / fails on substring', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'utm_source', operator: 'contains', value: 'goo' }],
        targetingCtx(),
      ),
    ).toBe(true);
    expect(
      evaluateLegacyTargeting(
        [{ type: 'utm_source', operator: 'contains', value: 'bing' }],
        targetingCtx(),
      ),
    ).toBe(false);
  });

  it('contains fails when the param is absent (falsy val)', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'missing', operator: 'contains', value: 'x' }],
        targetingCtx(),
      ),
    ).toBe(false);
  });

  it('not_contains passes when the param is absent', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'missing', operator: 'not_contains', value: 'x' }],
        targetingCtx(),
      ),
    ).toBe(true);
  });
});

// ─── targeting: OR within a type, AND across types ───────────────────────────

describe('evaluateLegacyTargeting — group semantics', () => {
  it('ORs rules within the same type (one passing rule is enough)', () => {
    const rules: LegacyRule[] = [
      { type: 'utm_source', operator: 'equals', value: 'bing' }, // fails
      { type: 'utm_source', operator: 'equals', value: 'google' }, // passes
    ];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(true);
  });

  it('ANDs across types (every type-group must pass)', () => {
    const rules: LegacyRule[] = [
      { type: 'utm_source', operator: 'equals', value: 'google' }, // passes
      { type: 'plan', operator: 'equals', value: 'enterprise' }, // fails
    ];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(false);
  });

  it('passes when every type-group has at least one passing rule', () => {
    const rules: LegacyRule[] = [
      { type: 'utm_source', operator: 'equals', value: 'google' },
      { type: 'plan', operator: 'contains', value: 'pr' },
      { type: 'region_country', operator: 'equals', value: 'US' },
      { type: 'device', operator: 'equals', value: 'desktop' },
    ];
    expect(evaluateLegacyTargeting(rules, targetingCtx())).toBe(true);
  });

  it('empty rule set targets everyone', () => {
    expect(evaluateLegacyTargeting([], targetingCtx())).toBe(true);
  });
});

// ─── targeting: region ───────────────────────────────────────────────────────

describe('evaluateLegacyTargeting — region', () => {
  it('equals matches the geo country', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'region_country', operator: 'equals', value: 'US' }],
        targetingCtx(),
      ),
    ).toBe(true);
  });

  it('not_equals excludes a matching country', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'region_country', operator: 'not_equals', value: 'US' }],
        targetingCtx(),
      ),
    ).toBe(false);
  });

  it('fails closed when geo country is undefined', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'region_country', operator: 'equals', value: 'US' }],
        targetingCtx({ geo: {} }),
      ),
    ).toBe(false);
  });
});

// ─── targeting: device ───────────────────────────────────────────────────────

describe('evaluateLegacyTargeting — device', () => {
  it('equals desktop matches the desktop flag', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'device', operator: 'equals', value: 'desktop' }],
        targetingCtx(),
      ),
    ).toBe(true);
  });

  it('equals mobile fails on a desktop', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'device', operator: 'equals', value: 'mobile' }],
        targetingCtx(),
      ),
    ).toBe(false);
  });

  it('not_equals inverts the flag', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'device', operator: 'not_equals', value: 'mobile' }],
        targetingCtx(),
      ),
    ).toBe(true);
  });

  it('matches mobile when the mobile flag is set', () => {
    expect(
      evaluateLegacyTargeting(
        [{ type: 'device', operator: 'equals', value: 'mobile' }],
        targetingCtx({ device: { isMobile: true, isTablet: false, isDesktop: false } }),
      ),
    ).toBe(true);
  });
});

// ─── exclusions ──────────────────────────────────────────────────────────────

function exclusionCtx(overrides?: Partial<LegacyExclusionContext>): LegacyExclusionContext {
  return {
    url: 'https://store.example.com/cart?step=2',
    cookieString: 'session=abc; _ga=GA1.2.345',
    belongsToExperiment: () => false,
    ...overrides,
  };
}

describe('evaluateLegacyExclusions — url', () => {
  it('excludes (false) when a contains url exclusion matches', () => {
    const rules: LegacyExclusion[] = [{ type: 'url', operator: 'contains', value: '/cart' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('passes (true) when the contains exclusion does not match', () => {
    const rules: LegacyExclusion[] = [{ type: 'url', operator: 'contains', value: '/checkout' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(true);
  });

  it('not_contains exclusion excludes when url does NOT contain (inversion)', () => {
    // urlMatches(not_contains) is true when url lacks the value, so
    // `!urlMatches` = false ⇒ excluded.
    const rules: LegacyExclusion[] = [{ type: 'url', operator: 'not_contains', value: '/admin' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('exact exclusion matches origin+pathname ignoring extra params', () => {
    const rules: LegacyExclusion[] = [
      { type: 'url', operator: 'exact', value: 'https://store.example.com/cart' },
    ];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('regex exclusion matches', () => {
    const rules: LegacyExclusion[] = [{ type: 'url', operator: 'regex', value: 'cart\\?step=\\d' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('site_wide exclusion always excludes', () => {
    const rules: LegacyExclusion[] = [{ type: 'url', operator: 'site_wide', value: '' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });
});

describe('evaluateLegacyExclusions — cookie', () => {
  it('excludes when the cookie string contains the value', () => {
    const rules: LegacyExclusion[] = [{ type: 'cookie', operator: 'contains', value: '_ga' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('passes when the cookie is absent', () => {
    const rules: LegacyExclusion[] = [{ type: 'cookie', operator: 'contains', value: 'optout' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(true);
  });

  it('not_contains cookie excludes when cookie is absent (inversion)', () => {
    const rules: LegacyExclusion[] = [
      { type: 'cookie', operator: 'not_contains', value: 'optout' },
    ];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(false);
  });

  it('unknown cookie operator never excludes (legacy undefined → !undefined)', () => {
    const rules: LegacyExclusion[] = [{ type: 'cookie', operator: 'exact', value: '_ga' }];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(true);
  });
});

describe('evaluateLegacyExclusions — experiment', () => {
  it('excludes when the visitor belongs to the experiment', () => {
    const rules: LegacyExclusion[] = [{ type: 'experiment', operator: 'equals', value: '42' }];
    const ctx = exclusionCtx({ belongsToExperiment: (id) => id === 42 });
    expect(evaluateLegacyExclusions(rules, ctx)).toBe(false);
  });

  it('passes when the visitor is not in the experiment', () => {
    const rules: LegacyExclusion[] = [{ type: 'experiment', operator: 'equals', value: '42' }];
    const ctx = exclusionCtx({ belongsToExperiment: (id) => id === 99 });
    expect(evaluateLegacyExclusions(rules, ctx)).toBe(true);
  });
});

describe('evaluateLegacyExclusions — composition', () => {
  it('passes only when no exclusion matches', () => {
    const rules: LegacyExclusion[] = [
      { type: 'url', operator: 'contains', value: '/checkout' },
      { type: 'cookie', operator: 'contains', value: 'optout' },
      { type: 'experiment', operator: 'equals', value: '7' },
    ];
    expect(evaluateLegacyExclusions(rules, exclusionCtx())).toBe(true);
  });

  it('empty exclusions passes', () => {
    expect(evaluateLegacyExclusions([], exclusionCtx())).toBe(true);
  });
});

/**
 * Legacy `targeting[]` audience evaluator (3.3.x / 3.6 compat).
 *
 * Ports the `shouldTarget` / `handleExclusions` helpers from the legacy
 * integration script (`crobot/.../3.3.3/script.js`) into a pure,
 * injected-context evaluator so the new pixel can keep serving customers
 * whose experiments still ship the old flat-rule shape during the
 * transition window.
 *
 * Deliberately standalone: nothing here is wired into `lifecycle.ts` yet
 * (there is no config field for legacy targeting). These are exported
 * evaluators for integration to call once a compat surface exists.
 *
 * Faithful to the legacy truthiness — including the `handleExclusions`
 * inversions (`result = !urlMatches(...)`) — rather than "cleaned up".
 * The new tree-shaped evaluator lives in `./audience.ts`.
 */

// ─── operators ───────────────────────────────────────────────────────────────

/** URL-parameter rule operators (legacy `handleURLParameter`). */
export type LegacyUrlParamOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains';

/** Region rule operators (legacy `handleRegion`). */
export type LegacyRegionOperator = 'equals' | 'not_equals';

/** Device rule operators (legacy `handleDevice`). */
export type LegacyDeviceOperator = 'equals' | 'not_equals';

/** Exclusion match types shared by url / cookie (legacy `urlMatches` / `cookieMatches`). */
export type LegacyMatchType = 'exact' | 'contains' | 'not_contains' | 'regex' | 'site_wide';

// ─── rule / exclusion shapes ─────────────────────────────────────────────────

/**
 * A single legacy targeting rule.
 *
 * `type` is the dispatch key AND (for the URL-parameter path) the name of
 * the query parameter to read — this doubles up in the legacy code, so a
 * rule like `{ type: 'utm_source', operator: 'equals', value: 'google' }`
 * reads the `utm_source` query param.
 */
export interface LegacyRule {
  /** `region_country` | `device` | `<query-param-name>`. */
  type: string;
  operator: string;
  value: string;
}

/** A single legacy exclusion rule (`handleExclusions`). */
export interface LegacyExclusion {
  type: 'url' | 'cookie' | 'experiment';
  operator: string;
  value: string;
}

// ─── injected contexts ───────────────────────────────────────────────────────

/** Device classification flags (legacy `isMobile`/`isTablet`/`isDesktop`). */
export interface LegacyDeviceFlags {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

/** Injected context for `evaluateLegacyTargeting`. */
export interface LegacyTargetingContext {
  /** Parsed query params (name → value). Absent param ⇒ `undefined`. */
  queryParams: ReadonlyMap<string, string>;
  /** Geo values keyed as in the legacy `geoData` object. */
  geo: { country?: string; region?: string };
  device: LegacyDeviceFlags;
}

/** Injected context for `evaluateLegacyExclusions`. */
export interface LegacyExclusionContext {
  /** Full current URL (legacy read `window.location.href`). */
  url: string;
  /** Raw cookie string (legacy read `document.cookie`). */
  cookieString: string;
  /** Predicate: is the visitor bucketed into `experimentId`? */
  belongsToExperiment: (experimentId: number) => boolean;
}

// ─── targeting entry point ───────────────────────────────────────────────────

/**
 * Legacy `shouldTarget`: group rules by `type`; a group passes if AT LEAST
 * ONE of its rules passes (OR within a type); ALL groups must pass (AND
 * across types). No rules ⇒ targeted.
 *
 * @returns `true` when the visitor should be targeted.
 */
export function evaluateLegacyTargeting(
  rules: readonly LegacyRule[],
  ctx: LegacyTargetingContext,
): boolean {
  const groups = new Map<string, LegacyRule[]>();
  for (const rule of rules) {
    const bucket = groups.get(rule.type);
    if (bucket) {
      bucket.push(rule);
    } else {
      groups.set(rule.type, [rule]);
    }
  }

  for (const bucket of groups.values()) {
    const passed = bucket.some((rule) => evaluateTargetingRule(rule, ctx));
    if (!passed) return false;
  }

  return true;
}

function evaluateTargetingRule(rule: LegacyRule, ctx: LegacyTargetingContext): boolean {
  switch (rule.type) {
    case 'region_country':
      return handleRegion(rule, ctx.geo.country);
    case 'device':
      return handleDevice(rule, ctx.device);
    default:
      return handleUrlParameter(rule, ctx.queryParams);
  }
}

/** Legacy `handleURLParameter` — `rule.type` is the query-param name. */
function handleUrlParameter(rule: LegacyRule, queryParams: ReadonlyMap<string, string>): boolean {
  const val = queryParams.get(rule.type) ?? null;
  switch (rule.operator) {
    case 'equals':
      return rule.value === val;
    case 'not_equals':
      return rule.value !== val;
    case 'contains':
      // Legacy: `val && val.includes(value)` — falsy `val` (null/'') fails.
      return !!val && val.includes(rule.value);
    case 'not_contains':
      // Legacy: `!val || !val.includes(value)`.
      return !val || !val.includes(rule.value);
    default:
      // Legacy `result` stays `true` for unknown operators.
      return true;
  }
}

/** Legacy `handleRegion` — undefined geo value fails closed. */
function handleRegion(rule: LegacyRule, geoValue: string | undefined): boolean {
  if (geoValue === undefined) return false;
  switch (rule.operator) {
    case 'equals':
      return rule.value === geoValue;
    case 'not_equals':
      return rule.value !== geoValue;
    default:
      return false;
  }
}

/** Legacy `handleDevice` — equals ⇒ flag, anything else ⇒ !flag. */
function handleDevice(rule: LegacyRule, device: LegacyDeviceFlags): boolean {
  const flag = deviceFlag(rule.value, device);
  if (flag === undefined) return false;
  return rule.operator === 'equals' ? flag : !flag;
}

function deviceFlag(value: string, device: LegacyDeviceFlags): boolean | undefined {
  switch (value) {
    case 'mobile':
      return device.isMobile;
    case 'tablet':
      return device.isTablet;
    case 'desktop':
      return device.isDesktop;
    default:
      return undefined;
  }
}

// ─── exclusion entry point ───────────────────────────────────────────────────

/**
 * Legacy `handleExclusions`: iterate exclusions; if ANY matches, the
 * visitor is excluded. Note the legacy inversions preserved below —
 * `result = !urlMatches(...)`, `result = !belongsToExperiment(...)`.
 *
 * @returns `true` when the visitor is NOT excluded (passes).
 */
export function evaluateLegacyExclusions(
  rules: readonly LegacyExclusion[],
  ctx: LegacyExclusionContext,
): boolean {
  for (const rule of rules) {
    let result = true;
    switch (rule.type) {
      case 'url':
        result = !urlMatches(ctx.url, rule.value, rule.operator);
        break;
      case 'cookie':
        result = !cookieMatches(ctx.cookieString, rule.value, rule.operator);
        break;
      case 'experiment':
        result = !ctx.belongsToExperiment(Number.parseInt(rule.value, 10));
        break;
      default:
        // Unknown exclusion type: `result` stays true (not excluded).
        break;
    }

    if (!result) return false;
  }

  return true;
}

/** Legacy `urlMatches` against an injected URL. */
function urlMatches(currentUrl: string, expected: string, matchType: string): boolean {
  switch (matchType) {
    case 'exact':
      return compareUrls(currentUrl, expected);
    case 'contains':
      return currentUrl.includes(expected);
    case 'not_contains':
      return !currentUrl.includes(expected);
    case 'regex':
      return safeRegex(expected).test(currentUrl);
    default:
      // Legacy returns `matchType === 'site_wide'`.
      return matchType === 'site_wide';
  }
}

/** Legacy `cookieMatches` against an injected raw cookie string. */
function cookieMatches(cookieString: string, expected: string, matchType: string): boolean {
  switch (matchType) {
    case 'contains':
      return cookieString.includes(expected);
    case 'not_contains':
      return !cookieString.includes(expected);
    case 'regex':
      return safeRegex(expected).test(cookieString);
    default:
      // Legacy returns `undefined` (falsy) for unhandled operators.
      return false;
  }
}

/** Legacy `compareUrls`: same origin+pathname AND every expected param matches. */
function compareUrls(actual: string, expected: string): boolean {
  let actualUrl: URL;
  let expectedUrl: URL;
  try {
    actualUrl = new URL(actual);
    expectedUrl = new URL(expected);
  } catch {
    return false;
  }

  if (actualUrl.origin + actualUrl.pathname !== expectedUrl.origin + expectedUrl.pathname) {
    return false;
  }

  for (const key of expectedUrl.searchParams.keys()) {
    if (actualUrl.searchParams.get(key) !== expectedUrl.searchParams.get(key)) {
      return false;
    }
  }

  return true;
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Bad pattern from the admin UI — match nothing rather than throwing.
    return /(?!)/;
  }
}

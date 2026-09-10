/**
 * Host-neutral experiment decision engine. No Next import — pure over a
 * `CookieStore` + request context, fully unit-testable with fakes.
 *
 * Assigns BOTH split-URL (redirect) and DOM (css/html/text/… ) experiments in
 * one pass: it always buckets + writes the sticky `_testa_exp` cookie so the
 * assignment is fixed server-side, and only *redirects* when the assigned
 * variation carries a redirect change. DOM changes aren't applied here (no DOM
 * on the server) — the client `<TestaExperiments/>` reads the same cookie and
 * applies them, cookie-first (no re-bucket).
 *
 * Session-scoped, first-touch targeting (crobot 3.3.3 parity — see session.ts).
 *
 * Per request:
 *   0. Apply inbound cross-domain assignments (`?_testa_cd=…`) so a visitor
 *      carried from another domain keeps their variation.
 *   1. For each ACTIVE experiment:
 *      a. Targeting gate — evaluated SITE-WIDE (before the page rule) and CACHED
 *         first-touch. A UTM on the landing page is evaluated there and the
 *         verdict cached, so the visitor stays eligible on a later, UTM-less page.
 *         A fail is a flat exclusion cooldown; both verdicts carry a sliding
 *         window (`sessionLengthSec`, default 30m) and recompute once it expires.
 *         Targeting is grouped: OR within a dimension, AND across dimensions.
 *      b. Page gate — only ENROLL on the experiment's own page (eligibility is
 *         already cached above, so being off-page never loses it).
 *      c. Exclusion rules (`exclusions[]` list) — on-page entry gate for new
 *         visitors, evaluated each time (not cached).
 *      d. Assign (cookie-first + deterministic bucket) and stamp/slide the session
 *         window — the conversion-attribution clock (`isSessionLive`). State lives
 *         in the packed `_testa_exp` cookie, the SAME format the v2 pixel uses.
 *      e. Emit a `variation_applied` event; if the assigned variation is a
 *         redirect, resolve the destination and redirect (first redirect wins;
 *         DOM-only experiments fall through and accumulate).
 *
 * The caller (middleware) MUST only invoke this on a real navigation, never a
 * prefetch — the engine commits cookies via the store and fires listener events.
 */

import type {
  ExperimentConfig,
  ExperimentRule,
  GoalConfig,
  ProjectConfig,
  TargetingCondition,
  VariationConfig,
} from '@testa-platform/shared-types';
import { applyAssignment, assign } from './assign.ts';
import { ASSIGNMENT_COOKIE, type CookieStore } from './cookie-store.ts';
import { CROSS_DOMAIN_PARAM, decodeCrossDomain } from './cross-domain.ts';
import { shuffleForVisitor } from './order.ts';
import { ELIGIBLE_PENDING_VARIATION_ID, parsePacked } from './packed-cookie.ts';
import { isAtRedirectDestination as isAtDestinationForChange } from './redirect/at-destination.ts';
import { type RedirectChange, resolveRedirectDestination } from './redirect/decide.ts';
import { matchesForMode } from './redirect/match.ts';
import {
  SESSION_LENGTH_SEC,
  cacheEligible,
  cacheExclusion,
  isAssigned,
  isFresh,
  refreshSession,
} from './session.ts';
import { type TargetingContext, isExcludedByRules, passesTargeting } from './targeting.ts';
import { queryKeysOf, traceUrl } from './trace.ts';

/** Payload passed to the `onVariationApplied` listener when a visitor is enrolled. */
export interface VariationAppliedEvent {
  experimentId: number;
  variationId: number;
  /** Experiment title, when set (for the exposure payload / listener). */
  title?: string;
  /** True when the applied variation triggered a server-side redirect. */
  redirected: boolean;
  /** Resolved destination URL, present when `redirected`. */
  destinationUrl?: string;
  visitorId: string;
  /** The request URL the variation was applied on. */
  url: string;
  /** True when freshly bucketed on this request; false when served from the sticky cookie. */
  firstAssignment: boolean;
}

/** Why a given experiment reached the outcome it did (only collected when `debug`). */
export type DecisionReason =
  | 'inactive' // status !== 'active'
  | 'page_no_match' // current URL doesn't match the experiment's page rule
  | 'excluded_by_rules' // an exclusion rule matched
  | 'targeting_failed' // a targeting rule was not satisfied
  | 'traffic_excluded' // bucketed out by traffic_allocation
  | 'assigned_dom' // assigned a variation with DOM/no changes (no redirect)
  | 'redirect' // assigned a redirect variation and will navigate
  | 'redirect_skipped'; // redirect variation but no navigation (already there / invalid / no match)

export interface DecisionTrace {
  experimentId: number;
  title?: string;
  reason: DecisionReason;
  /** Assigned variation when the experiment enrolled the visitor. */
  variationId?: number;
  /** True when freshly bucketed this run; false when read from the sticky cookie. */
  fromCookie?: boolean;
  /** Extra context, e.g. the page rule that failed or the redirect skip reason. */
  detail?: string;
}

export interface EngineResult {
  /** Destination to 307-redirect to, if an experiment fired. */
  redirectTo?: string;
  /** Every variation applied on this request (control + variant), in order. */
  applied: VariationAppliedEvent[];
  /** Per-experiment decision trace — populated only when `ctx.debug` is true. */
  trace?: DecisionTrace[];
}

export interface EngineContext {
  config: ProjectConfig;
  currentUrl: string;
  visitorId: string;
  now: number;
  /** Read a request cookie (for `cookie` targeting). */
  getCookie: (name: string) => string | null;
  userAgent?: string;
  /** ISO country code from a geo header, when available. */
  country?: string;
  /** Collect a per-experiment `DecisionTrace` into the result. Default false. */
  debug?: boolean;
  /** Session / exclusion-cooldown window in seconds. Default `SESSION_LENGTH_SEC` (30m). */
  sessionLengthSec?: number;
}

export function runExperiments(ctx: EngineContext, store: CookieStore): EngineResult {
  const applied: VariationAppliedEvent[] = [];
  const trace: DecisionTrace[] = [];
  const note = (t: DecisionTrace): void => {
    if (ctx.debug) trace.push(t);
  };
  const withTrace = (r: EngineResult): EngineResult => (ctx.debug ? { ...r, trace } : r);

  traceUrl({
    stage: 'engine-input',
    in: ctx.currentUrl,
    detail: { keys: queryKeysOf(ctx.currentUrl), visitorId: ctx.visitorId, country: ctx.country },
  });

  applyInboundCrossDomain(ctx.currentUrl, ctx.config, store);

  const targetingCtx: TargetingContext = {
    url: ctx.currentUrl,
    getCookie: ctx.getCookie,
    ...(ctx.userAgent !== undefined ? { userAgent: ctx.userAgent } : {}),
    ...(ctx.country !== undefined ? { country: ctx.country } : {}),
  };

  const nowSec = Math.floor(ctx.now / 1000);
  const expiresSec = nowSec + (ctx.sessionLengthSec ?? SESSION_LENGTH_SEC);
  const packed = parsePacked(store.get(ASSIGNMENT_COOKIE));

  // Randomized evaluation order (3.3.3 `shuffleArray` parity, deterministic
  // per visitor): with mutual exclusions + 100% traffic on N experiments, the
  // shuffle splits NEW visitors evenly between them. See order.ts.
  for (const experiment of shuffleForVisitor(ctx.config.experiments, ctx.visitorId)) {
    const id = experiment.experiment_id;
    const title = experiment.title;
    const base = { experimentId: id, ...(title ? { title } : {}) };

    if (experiment.status !== 'active') {
      note({ ...base, reason: 'inactive', detail: `status=${experiment.status}` });
      continue;
    }

    const state = packed.get(id);
    const onPage = matchesPageRule(ctx.currentUrl, experiment.rules);
    traceUrl({
      stage: 'page-rule',
      in: ctx.currentUrl,
      detail: { experiment: id, onPage, rules: describeRules(experiment.rules), state },
    });

    // a. Targeting gate — evaluated SITE-WIDE (before the page rule) and CACHED
    // first-touch (crobot 3.3.3 `_testa_excl`). A UTM on the landing page is
    // evaluated there and the verdict is cached, so the visitor stays eligible
    // on a later, UTM-less page. A fail becomes a flat cooldown (sliding window),
    // not re-evaluated mid-window; when it expires it is recomputed.
    if (!isAssigned(state)) {
      if (state?.excluded && isFresh(state, nowSec)) {
        note({ ...base, reason: 'targeting_failed', detail: 'excluded (cached, in cooldown)' });
        continue;
      }
      const eligibleCached =
        state?.variation === ELIGIBLE_PENDING_VARIATION_ID && isFresh(state, nowSec);
      if (!eligibleCached) {
        if (!passesTargeting(experiment.targeting, targetingCtx)) {
          cacheExclusion(store, id, expiresSec);
          note({
            ...base,
            reason: 'targeting_failed',
            detail: describeTargeting(experiment.targeting),
          });
          continue;
        }
        // Passed: cache the eligibility (fixed-TTL, like 3.3.3's `_testa_excl`).
        // This also OVERWRITES any stale/expired exclusion in the cookie —
        // otherwise `assign()`'s cookie-first would honour the old `excluded=1`
        // and refuse to enroll after the cooldown.
        cacheEligible(store, id, expiresSec);
      }
    }

    // b. Page-rule gate — only ENROLL on the experiment's page. Eligibility is
    // already cached above, so being off-page never loses it.
    if (!onPage) {
      note({ ...base, reason: 'page_no_match', detail: describeRules(experiment.rules) });
      continue;
    }

    // c. Exclusion rules (the `exclusions[]` list) — evaluated on-page on EVERY
    // pass, for assigned visitors too (3.3.3 `handleExclusions` runs before the
    // sticky cookie is honoured). A match blocks apply/redirect for THIS
    // pageview only: the assignment stays in the cookie, never re-rolled, and
    // applies again once the exclusion stops matching. This is what makes
    // `dimension: 'experiment'` a real mutual exclusion — being in the other
    // experiment suppresses this one no matter when either was assigned.
    if (isExcludedByRules(experiment.exclusions, targetingCtx)) {
      note({ ...base, reason: 'excluded_by_rules' });
      continue;
    }

    // d. Assign (packed `_testa_exp` — same format as the v2 pixel).
    const result = assign(
      {
        experiment_id: experiment.experiment_id,
        traffic_allocation: experiment.traffic_allocation,
        variations: experiment.variations.map((v) => ({
          variation_id: v.variation_id,
          weight: v.weight,
        })),
      },
      { visitorId: ctx.visitorId, now: ctx.now },
      store,
    );
    if (result.isExcluded) {
      note({
        ...base,
        reason: 'traffic_excluded',
        detail: `traffic=${experiment.traffic_allocation}`,
      });
      continue;
    }

    // Enrolled: stamp / slide the session window (conversion-attribution clock).
    refreshSession(store, id, result.variationId, expiresSec);

    // e. Resolve redirect (if the applied variation is a redirect) + emit event.
    const variation = experiment.variations.find((v) => v.variation_id === result.variationId);
    const change = variation ? redirectChangeOf(variation) : undefined;
    const dest = change ? resolveRedirectDestination(change, ctx.currentUrl) : undefined;
    const redirected = Boolean(dest?.shouldRedirect && dest.finalUrl);

    applied.push({
      experimentId: experiment.experiment_id,
      variationId: result.variationId,
      ...(experiment.title ? { title: experiment.title } : {}),
      redirected,
      ...(redirected && dest?.finalUrl ? { destinationUrl: dest.finalUrl } : {}),
      visitorId: ctx.visitorId,
      url: ctx.currentUrl,
      firstAssignment: !result.fromCookie,
    });

    if (redirected && dest?.finalUrl) {
      note({
        ...base,
        reason: 'redirect',
        variationId: result.variationId,
        fromCookie: result.fromCookie,
        detail: `-> ${dest.finalUrl}`,
      });
      return withTrace({ redirectTo: dest.finalUrl, applied });
    }

    note({
      ...base,
      reason: change ? 'redirect_skipped' : 'assigned_dom',
      variationId: result.variationId,
      fromCookie: result.fromCookie,
      ...(change && dest ? { detail: dest.reason } : {}),
    });
  }

  return withTrace({ applied });
}

/** Human-readable page-rule summary for the debug trace. */
function describeRules(rules: ExperimentRule[]): string {
  if (!rules || rules.length === 0) return '(no rules — matches everywhere)';
  return rules.map((r) => `${r.match_type} "${r.url_pattern}"`).join(' AND ');
}

/** Human-readable targeting summary for the debug trace. */
function describeTargeting(targeting: TargetingCondition[] | undefined): string {
  if (!targeting || targeting.length === 0) return '(no targeting)';
  return targeting.map((t) => `${t.dimension} ${t.operator} "${t.value}"`).join(', ');
}

function applyInboundCrossDomain(url: string, config: ProjectConfig, store: CookieStore): void {
  const q = url.indexOf(`${CROSS_DOMAIN_PARAM}=`);
  if (q === -1) return;
  let raw: string;
  try {
    raw = new URL(url, 'https://placeholder.invalid').searchParams.get(CROSS_DOMAIN_PARAM) ?? '';
  } catch {
    return;
  }
  const payload = decodeCrossDomain(raw);
  if (!payload) return;
  const crossDomainIds = new Set(
    config.experiments.filter((e) => e.cross_domain).map((e) => Number(e.experiment_id)),
  );
  for (const a of payload.assignments) {
    if (crossDomainIds.has(Number(a.experimentId))) {
      applyAssignment(store, a.experimentId, a.variationId);
    }
  }
}

/**
 * Should the anti-flicker shield be raised for THIS request? True iff some
 * active experiment whose page rule matches `url` assigns this visitor (via the
 * packed `_testa_exp` cookie) a variation carrying a NON-redirect (DOM) change.
 *
 * Split-URL redirects need no shield — the 307 happens before any HTML is sent,
 * so the control page is never painted. Pages the experiment doesn't target, and
 * excluded/unassigned visitors, also return false. So the shield is raised ONLY
 * when there's genuinely control content about to be mutated — never on a
 * split-URL-only project, and never on a page with nothing to change.
 *
 * Call it AFTER assignment (the packed cookie must reflect this request's
 * bucketing) — e.g. right before the middleware returns its pass-through.
 */
export function hasPendingDomChange(
  config: ProjectConfig,
  url: string,
  cookieValue: string | null,
): boolean {
  const map = parsePacked(cookieValue);
  if (map.size === 0) return false;

  for (const experiment of config.experiments) {
    if (experiment.status !== 'active') continue;
    if (!matchesPageRule(url, experiment.rules)) continue;

    const state = map.get(Number(experiment.experiment_id));
    // Skip excluded and the eligible-but-unassigned sentinel (both variation < 0).
    if (!state || state.excluded || state.variation < 0) continue;

    const variation = experiment.variations.find((v) => v.variation_id === state.variation);
    if (variation?.changes.some((c) => c.type !== 'redirect')) return true;
  }
  return false;
}

/**
 * Does `url` match an experiment's page rules? Exported so the client DOM-apply
 * layer gates on the SAME rule the engine enrolls on — a variation must only be
 * applied on the experiment's own page, never on every page the visitor is
 * assigned across.
 */
export function matchesPageRule(url: string, rules: ExperimentRule[]): boolean {
  if (!rules || rules.length === 0) return true;
  return rules.every((r) => matchesRule(url, r));
}

/** One experiment the visitor is currently exposed to (for `variation_applied`). */
export interface Exposure {
  experimentId: number;
  variationId: number;
  title?: string;
}

/**
 * Which experiments is this visitor EXPOSED to on `url` right now — assigned a
 * variation (INCLUDING control), the page rule matches, and the session window
 * is still live. This is the set the client fires `variation_applied` for
 * (split-URL, DOM, and control alike) — distinct from the DOM-apply subset,
 * which drops control + redirect-only. Cookie-first: reads the packed cookie,
 * never buckets.
 */
export function resolveExposures(
  config: ProjectConfig,
  cookieValue: string | null,
  url: string,
  nowSec: number,
): Exposure[] {
  const map = parsePacked(cookieValue);
  if (map.size === 0) return [];

  const out: Exposure[] = [];
  for (const experiment of config.experiments) {
    if (experiment.status !== 'active') continue;
    const state = map.get(Number(experiment.experiment_id));
    if (!state || !isAssigned(state) || !isFresh(state, nowSec)) continue;
    // The page rule scopes an experiment to its own pages — but a split-URL
    // variant visitor is standing somewhere the rule was never written to
    // match. `/question/male/1 → /question/female/1` with a rule of
    // `contains /question/male` matches the control URL and NOT the
    // destination, so the variant group produced no exposure anywhere: they had
    // already left the control page before the apply step, and the destination
    // failed the gate. Being at the destination of a redirect you are assigned
    // to IS the exposure.
    if (
      !matchesPageRule(url, experiment.rules) &&
      !isAtRedirectDestination(experiment, state.variation, url)
    ) {
      continue;
    }
    out.push({
      experimentId: experiment.experiment_id,
      variationId: state.variation,
      ...(experiment.title ? { title: experiment.title } : {}),
    });
  }
  return out;
}

/**
 * Is `url` the destination of the redirect this visitor's variation carries?
 *
 * Delegates the comparison to `redirect/at-destination.ts`, which follows the
 * variation's own `url_match_type` — the same mode that BUILT the destination.
 */
function isAtRedirectDestination(
  experiment: ExperimentConfig,
  variationId: number,
  url: string,
): boolean {
  const variation = experiment.variations.find(
    (v: VariationConfig) => v.variation_id === variationId,
  );
  const change = variation ? redirectChangeOf(variation) : undefined;
  return change ? isAtDestinationForChange(change, url) : false;
}

/** An experiment the visitor is assigned to whose goals should be live. */
export interface GoalAssignment {
  experimentId: number;
  variationId: number;
  goals: GoalConfig[];
}

/**
 * Which experiments should have their GOALS armed for this visitor right now —
 * assigned a variation (control included) and session-live (3.3.3
 * `belongsToExperiment` + `checkSession`). Deliberately NOT page-gated: a goal
 * usually completes on a different page than the experiment runs on (e.g.
 * experiment on /calculator, page_view goal on /quiz). Cookie-first: reads the
 * packed cookie, never buckets.
 */
export function resolveGoalExperiments(
  config: ProjectConfig,
  cookieValue: string | null,
  nowSec: number,
): GoalAssignment[] {
  const map = parsePacked(cookieValue);
  if (map.size === 0) return [];

  const out: GoalAssignment[] = [];
  for (const experiment of config.experiments) {
    if (experiment.status !== 'active') continue;
    if (!experiment.goals || experiment.goals.length === 0) continue;
    const state = map.get(Number(experiment.experiment_id));
    if (!state || !isAssigned(state) || !isFresh(state, nowSec)) continue;
    out.push({
      experimentId: experiment.experiment_id,
      variationId: state.variation,
      goals: experiment.goals,
    });
  }
  return out;
}

function matchesRule(url: string, rule: ExperimentRule): boolean {
  if (rule.match_type === 'not_contains') return !url.includes(rule.url_pattern);
  const mode =
    rule.match_type === 'contains' ? 'contains' : rule.match_type === 'regex' ? 'regex' : 'exact';
  return matchesForMode(url, rule.url_pattern, mode);
}

function redirectChangeOf(variation: VariationConfig): RedirectChange | undefined {
  return variation.changes.find((c): c is RedirectChange => c.type === 'redirect');
}

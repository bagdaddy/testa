/**
 * Audience condition evaluator.
 *
 * Walks an `AudienceCondition` tree (nestable `all`/`any`/`not` over
 * typed leaves) against a runtime `EvalContext`. Returns true iff the
 * visitor matches.
 *
 * Single source of truth for "should this experiment be shown to this
 * visitor on this page right now?" — used by `experiments/traffic.ts`
 * before bucketing.
 *
 * Out of scope for this file: `visitor.custom` (sandboxed JS / AST
 * evaluator). See `./custom-js.ts` (separate task) and the deferral
 * note in `tasks/phase-3/3.7-audience-rule-engine.md`.
 *
 * Out of scope as a unit: 3.3.x/3.6 legacy `targeting[]` shape — that
 * compat path lives in `./legacy.ts` so the new evaluator stays clean.
 */

import {
  type AudienceCondition,
  type AudienceLeaf,
  type DeviceType,
  type InOp,
  type NumOp,
  type StrOp,
  type UrlOp,
  isAllNode,
  isAnyNode,
  isNotNode,
} from '@testa-platform/shared-types';

export interface EvalContext {
  page: PageContext;
  visitor: VisitorContext;
  geo: GeoContext;
  device: DeviceContext;
  /** Wall-clock now. Injected for determinism in tests. Defaults to `Date.now()`. */
  now?: number;
  /** Currently-resolved experiment assignments for this visitor. */
  experiments?: ReadonlyMap<number, number>;
}

export interface PageContext {
  url: string;
  /** Lazy: parsed from `url` on first access. Provided here so callers can pre-parse. */
  queryParams?: ReadonlyMap<string, string>;
  referrer: string;
}

export interface VisitorContext {
  isReturning: boolean;
  /** Cookie name → value (for `visitor.cookie`). */
  cookies: ReadonlyMap<string, string>;
  /** dataLayer object (often `window.dataLayer[0]` flattened). */
  dataLayer?: Record<string, unknown>;
}

export interface GeoContext {
  country: string;
  region: string;
}

export interface DeviceContext {
  type: DeviceType | 'unknown';
  browser: string;
  os: string;
  viewportWidth: number;
  language: string;
}

/** Top-level entry. Returns `true` if the visitor matches the audience. */
export function evaluate(condition: AudienceCondition, ctx: EvalContext): boolean {
  if (isAllNode(condition)) {
    return condition.all.every((c) => evaluate(c, ctx));
  }
  if (isAnyNode(condition)) {
    return condition.any.some((c) => evaluate(c, ctx));
  }
  if (isNotNode(condition)) {
    return !evaluate(condition.not, ctx);
  }
  return evaluateLeaf(condition, ctx);
}

function evaluateLeaf(leaf: AudienceLeaf, ctx: EvalContext): boolean {
  switch (leaf.fact) {
    case 'page.url':
      return matchUrlOp(leaf.op, ctx.page.url, leaf.value);

    case 'page.queryParam': {
      const params = ctx.page.queryParams ?? parseQueryParams(ctx.page.url);
      const got = params.get(leaf.key) ?? '';
      const present = params.has(leaf.key);
      return matchStrOp(leaf.op, got, leaf.value, present);
    }

    case 'page.referrer':
      return matchUrlOp(leaf.op, ctx.page.referrer, leaf.value);

    case 'visitor.cookie': {
      const got = ctx.visitor.cookies.get(leaf.key) ?? '';
      const present = ctx.visitor.cookies.has(leaf.key);
      return matchStrOp(leaf.op, got, leaf.value, present);
    }

    case 'visitor.isReturning':
      return ctx.visitor.isReturning === leaf.value;

    case 'visitor.dataLayer': {
      const value = readDataLayerPath(ctx.visitor.dataLayer, leaf.path);
      const present = value !== undefined;
      const stringified = value === undefined ? '' : String(value);
      return matchStrOp(leaf.op, stringified, leaf.value, present);
    }

    case 'visitor.custom':
      // TODO(phase-3.7b): sandboxed AST evaluator. Crobot ships AST in JSON
      // at config-publish time; pixel walks the AST. Returns false until
      // that lands so customers using custom JS audiences are simply
      // excluded — safer than evaluating arbitrary JS via eval().
      return false;

    case 'geo.country':
      return matchInOp(leaf.op, ctx.geo.country, leaf.value);

    case 'geo.region':
      return matchInOp(leaf.op, ctx.geo.region, leaf.value);

    case 'device.type':
      return matchInOp(leaf.op, ctx.device.type, leaf.value);

    case 'device.browser':
      return matchInOp(leaf.op, ctx.device.browser, leaf.value);

    case 'device.os':
      return matchInOp(leaf.op, ctx.device.os, leaf.value);

    case 'device.viewportWidth':
      return matchNumOp(leaf.op, ctx.device.viewportWidth, leaf.value, leaf.max);

    case 'device.language':
      return matchStrOp(leaf.op, ctx.device.language, leaf.value, ctx.device.language !== '');

    case 'time.hourOfDay':
      return leaf.value.includes(hourOfDay(ctx.now ?? Date.now(), leaf.tz));

    case 'time.dayOfWeek':
      return leaf.value.includes(dayOfWeek(ctx.now ?? Date.now(), leaf.tz));

    case 'time.window':
      return inWindow(ctx.now ?? Date.now(), leaf.from, leaf.to);

    case 'experiment.assignedTo': {
      const current = ctx.experiments?.get(leaf.experimentId);
      const isAssigned = current !== undefined;
      const matchesVariation =
        leaf.variationId !== undefined ? current === leaf.variationId : isAssigned;
      return leaf.op === 'is' ? matchesVariation : !matchesVariation;
    }
  }
}

// ─── op handlers ────────────────────────────────────────────────────────────

function matchUrlOp(op: UrlOp, actual: string, expected: string): boolean {
  switch (op) {
    case 'exact':
      return actual === expected;
    case 'contains':
      return actual.includes(expected);
    case 'notContains':
      return !actual.includes(expected);
    case 'regex':
      return safeRegex(expected).test(actual);
    case 'startsWith':
      return actual.startsWith(expected);
    case 'endsWith':
      return actual.endsWith(expected);
  }
}

function matchStrOp(op: StrOp, actual: string, expected: string, present: boolean): boolean {
  switch (op) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'notContains':
      return !actual.includes(expected);
    case 'regex':
      return safeRegex(expected).test(actual);
    case 'exists':
      return present;
    case 'notExists':
      return !present;
  }
}

function matchNumOp(op: NumOp, actual: number, expected: number, max?: number): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
    case 'between':
      return max !== undefined && actual >= expected && actual <= max;
  }
}

function matchInOp<T extends string>(op: InOp, actual: T, candidates: readonly T[]): boolean {
  const hit = candidates.includes(actual);
  return op === 'in' ? hit : !hit;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Bad pattern from the admin UI — match nothing rather than throwing.
    return /(?!)/;
  }
}

function parseQueryParams(url: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  try {
    const u = new URL(url);
    u.searchParams.forEach((value, key) => {
      map.set(key, value);
    });
  } catch {
    // Bad URL — return empty map.
  }
  return map;
}

function readDataLayerPath(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const p of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

function hourOfDay(ts: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: tz,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number.parseInt(hour, 10);
}

function dayOfWeek(ts: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: tz,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  // 0 = Sunday matches the schema's convention.
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

function inWindow(ts: number, fromIso: string, toIso: string): boolean {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return ts >= from && ts <= to;
}

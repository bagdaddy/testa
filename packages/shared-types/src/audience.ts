/**
 * Audience targeting JSON shape per experiment.
 *
 * Tree of nestable boolean groups (`all`/`any`/`not`) over typed dimension
 * leaves. Replaces 3.3.x/3.6's flat `targeting[]` with implicit grouping.
 *
 * Pixel evaluator: `apps/pixel/src/runtime/audience.ts` (Phase 3.7).
 * Reference: `docs/reference/audience-schema.md`.
 */

export type AudienceCondition =
  | { all: AudienceCondition[] }
  | { any: AudienceCondition[] }
  | { not: AudienceCondition }
  | AudienceLeaf;

export type AudienceLeaf =
  | { fact: 'page.url'; op: UrlOp; value: string }
  | { fact: 'page.queryParam'; op: StrOp; key: string; value: string }
  | { fact: 'page.referrer'; op: UrlOp; value: string }
  | { fact: 'visitor.cookie'; op: StrOp; key: string; value: string }
  | { fact: 'visitor.isReturning'; op: 'is'; value: boolean }
  | { fact: 'visitor.dataLayer'; op: StrOp; path: string; value: string }
  | { fact: 'visitor.custom'; op: 'truthy'; js: string }
  | { fact: 'geo.country'; op: InOp; value: string[] }
  | { fact: 'geo.region'; op: InOp; value: string[] }
  | { fact: 'device.type'; op: InOp; value: DeviceType[] }
  | { fact: 'device.browser'; op: InOp; value: string[] }
  | { fact: 'device.os'; op: InOp; value: string[] }
  | { fact: 'device.viewportWidth'; op: NumOp; value: number; max?: number }
  | { fact: 'device.language'; op: StrOp; value: string }
  | { fact: 'time.hourOfDay'; op: 'in'; value: number[]; tz: string }
  | { fact: 'time.dayOfWeek'; op: 'in'; value: number[]; tz: string }
  | { fact: 'time.window'; op: 'between'; from: string; to: string; tz: string }
  | {
      fact: 'experiment.assignedTo';
      op: 'is' | 'isNot';
      experimentId: number;
      variationId?: number;
    };

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export type UrlOp = 'exact' | 'contains' | 'notContains' | 'regex' | 'startsWith' | 'endsWith';

export type StrOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'exists'
  | 'notExists';

export type NumOp = 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between';

export type InOp = 'in' | 'notIn';

/** Helper: type guards for the boolean group node shapes. */
export function isAllNode(c: AudienceCondition): c is { all: AudienceCondition[] } {
  return (
    typeof c === 'object' && c !== null && 'all' in c && Array.isArray((c as { all: unknown }).all)
  );
}

export function isAnyNode(c: AudienceCondition): c is { any: AudienceCondition[] } {
  return (
    typeof c === 'object' && c !== null && 'any' in c && Array.isArray((c as { any: unknown }).any)
  );
}

export function isNotNode(c: AudienceCondition): c is { not: AudienceCondition } {
  return typeof c === 'object' && c !== null && 'not' in c;
}

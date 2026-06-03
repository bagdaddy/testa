/**
 * Map an `EnrichedEvent` (wire format from edge) to a ClickHouse `events` row.
 *
 * Schema source-of-truth: `apps/collector/db/migrations/001_create_events.sql`.
 * Sent via JSONEachRow so column names and string-formatted timestamps must
 * match exactly. Defaults below mirror the table DEFAULT clauses so unspecified
 * fields don't end up as ClickHouse type errors.
 */

import type { EnrichedEvent } from '@testa-platform/shared-types';

export interface EventsRow {
  event_id: string;
  client_ts: string;
  server_ts: string;
  project_id: number;
  experiment_id: number | null;
  variation_id: number | null;
  visitor_id: string;
  session_id: string;
  event_name: string;
  url: string;
  referrer: string;
  country: string;
  region: string;
  region_subdivision: string;
  city: string;
  device_type: string;
  browser: string;
  os: string;
  viewport_w: number;
  viewport_h: number;
  tracker_version: string;
  is_bot: 0 | 1;
  consent_state: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  value_native: number;
  currency: string;
  order_id: string;
  items_count: number;
  props: Record<string, string>;
}

/** Format a Unix-ms timestamp as `YYYY-MM-DD HH:mm:ss.sss` UTC (DateTime64(3)-friendly). */
function toClickHouseDateTime64(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Stringify all values so the Map(LowCardinality(String), String) column accepts them. */
function stringifyProps(props: EnrichedEvent['props']): Record<string, string> {
  if (!props) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function rowFromEvent(ev: EnrichedEvent): EventsRow {
  return {
    event_id: ev.event_id,
    client_ts: toClickHouseDateTime64(ev.client_ts),
    server_ts: toClickHouseDateTime64(ev.server_ts),
    project_id: ev.project_id,
    experiment_id: ev.experiment_id ?? null,
    variation_id: ev.variation_id ?? null,
    visitor_id: ev.visitor_id,
    session_id: ev.session_id,
    event_name: ev.event_name,
    url: ev.url,
    referrer: ev.referrer ?? '',
    country: ev.country || 'XX',
    region: ev.region ?? '',
    region_subdivision: ev.region_subdivision ?? '',
    city: ev.city ?? '',
    device_type: ev.device_type ?? 'unknown',
    browser: ev.browser ?? '',
    os: ev.os ?? '',
    viewport_w: ev.viewport_w ?? 0,
    viewport_h: ev.viewport_h ?? 0,
    tracker_version: ev.tracker_version ?? '',
    is_bot: ev.is_bot,
    consent_state: ev.consent_state,
    utm_source: ev.utm_source ?? '',
    utm_medium: ev.utm_medium ?? '',
    utm_campaign: ev.utm_campaign ?? '',
    value_native: ev.value_native ?? 0,
    currency: ev.currency ?? '',
    order_id: ev.order_id ?? '',
    items_count: ev.items_count ?? 0,
    props: stringifyProps(ev.props),
  };
}

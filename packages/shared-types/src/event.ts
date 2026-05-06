import type { ConsentState } from './consent.ts';

/**
 * Reserved event names with first-class metric support (AOV, RPV, funnel, sessions).
 * Anything else is a generic event keyed by `event_name`.
 */
export type ReservedEventName =
  | 'page_view'
  | 'session_start'
  | 'experiment_view'
  | 'purchase'
  | 'add_to_cart'
  | 'checkout_start'
  /** Synthetic — pixel-side delivery health (queued/sent/dropped/retried/oldest_age). */
  | '_pixel_health';

export type EventName = ReservedEventName | (string & { __brand?: 'CustomEvent' });

/**
 * Wire format the pixel posts to the edge worker. Optional fields are omitted
 * when absent (not null) to keep payloads small.
 *
 * `event_id` is a UUIDv7 generated client-side and persisted in the IDB outbox.
 * Same retried event keeps the same UUID; collector dedups by `event_id` for
 * configured event names (default `purchase`).
 */
export interface PixelEvent {
  event_id: string;
  event_name: EventName;
  /** Client clock at fire time, Unix ms. Renamed from `ts` in 2026-05-06 schema extension. */
  client_ts: number;
  project_id: number;
  experiment_id?: number;
  variation_id?: number;
  visitor_id: string;
  session_id: string;
  url: string;
  referrer?: string;
  consent_state: ConsentState;
  /** Build-time pixel version, e.g. `'4.0.3'`. Diagnostic. */
  tracker_version: string;
  /** `window.innerWidth` / `window.innerHeight` at fire time. 0 if unavailable. */
  viewport_w: number;
  viewport_h: number;
  /** UTM params parsed from `location.search` by the pixel. Empty string if absent. */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** Revenue, present on purchase events. */
  value_native?: number;
  currency?: string;
  order_id?: string;
  items_count?: number;
  /** Generic key/value bag for custom events. Values are stringified at the edge. */
  props?: Record<string, string | number | boolean | null>;
}

/**
 * Enriched format the edge worker forwards to the collector. Adds geo (country,
 * region, region_subdivision, city), UA-derived device fields, bot signal, and
 * `server_ts`. Visitor IP is intentionally NOT included (privacy: truncated or
 * hashed at the edge before forwarding).
 */
export interface EnrichedEvent extends PixelEvent {
  /** Edge-worker reception time, Unix ms. Renamed from `ingested_at`. */
  server_ts: number;
  country: string;
  region: string;
  region_subdivision: string;
  city: string;
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
  browser: string;
  os: string;
  is_bot: 0 | 1;
}

/**
 * Batch envelope HMAC-signed by the edge worker, accepted by collector /_ingest.
 */
export interface IngestBatch {
  events: EnrichedEvent[];
  /** Unix milliseconds when the batch was signed. Used for ±5 min replay window check. */
  signed_at: number;
}

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
  | 'checkout_start';

export type EventName = ReservedEventName | (string & { __brand?: 'CustomEvent' });

/**
 * Wire format the pixel posts to the edge worker. Optional fields are omitted
 * when absent (not null) to keep payloads small.
 */
export interface PixelEvent {
  event_id: string;
  event_name: EventName;
  ts: number;
  project_id: number;
  experiment_id?: number;
  variation_id?: number;
  visitor_id: string;
  session_id: string;
  url: string;
  referrer?: string;
  consent_state: ConsentState;
  /** Revenue, present on purchase events. */
  value_native?: number;
  currency?: string;
  order_id?: string;
  items_count?: number;
  /** Generic key/value bag for custom events. Values are stringified at the edge. */
  props?: Record<string, string | number | boolean | null>;
}

/**
 * Enriched format the edge worker forwards to the collector. Adds geo, ASN, UA-derived
 * fields, bot signal, and ingested_at. Visitor IP is intentionally NOT included
 * (privacy: truncated or hashed at the edge before forwarding).
 */
export interface EnrichedEvent extends PixelEvent {
  ingested_at: number;
  country: string;
  region: string;
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

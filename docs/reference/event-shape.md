# Reference — Event shape

The wire format for events flowing browser → edge → collector → ClickHouse.

## TL;DR — the three shapes

1. **`PixelEvent`** — what the pixel POSTs to the edge worker (`POST /track`).
2. **`EnrichedEvent`** — what the edge worker POSTs to the collector (`POST /_ingest` body items). Adds geo / ASN / UA / bot / consent / ingested_at.
3. **CH `events` row** — the ClickHouse table column-by-column.

All three are kept in lockstep via `packages/shared-types/src/event.ts`. If you change one, change all three plus the migration.

## 1. PixelEvent — wire format from browser → edge

```ts
interface PixelEvent {
  event_id: string;          // UUIDv7, generated client-side per event, persisted in IDB outbox
  event_name: EventName;     // reserved or custom; validated at edge
  client_ts: number;         // Unix ms, client clock at fire time (renamed from `ts`)
  project_id: number;
  experiment_id?: number;    // omitted for non-experiment events
  variation_id?: number;     // omitted for non-experiment events
  visitor_id: string;        // _testa_uuid (server-set when in CNAME mode)
  session_id: string;        // _testa_ses
  url: string;               // full URL (path + query, no fragment)
  referrer?: string;         // document.referrer if same-origin or trusted
  consent_state: ConsentState; // 'granted' | 'denied' | 'unknown'
  tracker_version: string;   // build-time pixel version, e.g. '4.0.3'
  viewport_w: number;        // window.innerWidth at fire time, 0 if unavailable
  viewport_h: number;        // window.innerHeight at fire time, 0 if unavailable
  utm_source?: string;       // parsed from location.search by the pixel
  utm_medium?: string;
  utm_campaign?: string;
  // revenue (purchase events only)
  value_native?: number;     // 49.99
  currency?: string;         // ISO 4217, e.g. 'USD'
  order_id?: string;
  items_count?: number;
  // generic
  props?: Record<string, string | number | boolean | null>;
}
```

Reserved event names: `page_view`, `session_start`, `experiment_view`, `purchase`, `add_to_cart`, `checkout_start`, `_pixel_health`. Anything else is custom — it lands as a generic event keyed on `event_name`.

### Required-by-event-name

| Event | Required fields |
|---|---|
| `page_view` | url |
| `session_start` | (auto, no extra) |
| `experiment_view` | experiment_id, variation_id |
| `purchase` | value_native, currency, order_id |
| `add_to_cart` | (optional value/currency) |
| `checkout_start` | (optional value/currency) |
| `_pixel_health` | (props with `queued`, `sent`, `dropped`, `retried`, `oldest_age_ms` numerics) |
| custom | event_name + (anything in props) |

The edge worker rejects events that fail their per-name required check (400).

### Idempotency

`event_id` is a UUIDv7 generated at the pixel and persisted in the IndexedDB outbox. The same event may be POSTed multiple times (pixel retry, edge retry); same `event_id` deduplicates at the Redis Stream layer in the collector — see `docs/architecture/02-collector.md` § Idempotency.

## 2. EnrichedEvent — edge → collector

The edge worker takes `PixelEvent`, drops fields you don't want forwarded (raw IP), and adds enrichment. Only the worker is allowed to set the enriched fields.

```ts
interface EnrichedEvent extends PixelEvent {
  server_ts: number;         // Unix ms when the worker received the event (renamed from `ingested_at`)
  country: string;           // CF-IPCountry, 2-letter, 'XX' if unknown
  region: string;            // CF region, may be empty
  region_subdivision: string;// CF-derived state/province, e.g. 'California'
  city: string;              // CF-IPCity, e.g. 'San Francisco'
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
  browser: string;           // ua-parser, e.g. 'Chrome', 'Safari'
  os: string;                // ua-parser, e.g. 'macOS 14.5', 'iOS 17.6'
  is_bot: 0 | 1;             // 1 if dropped by bot heuristic AND consent_state allows
}
```

IP is intentionally **not** in `EnrichedEvent`. It's truncated at the worker (last octet IPv4 / last 80 bits IPv6) and only used for enrichment + denied-consent visitor_id rotation. The collector never sees raw IPs.

## 3. CH `events` row — the warehouse shape

See `docs/reference/clickhouse-schema.md` for the canonical DDL. Mapping:

| EnrichedEvent field | CH column | CH type |
|---|---|---|
| event_id | event_id | UUID |
| client_ts | client_ts | DateTime64(3, 'UTC') |
| server_ts | server_ts | DateTime64(3, 'UTC') |
| project_id | project_id | UInt64 |
| experiment_id | experiment_id | Nullable(UInt64) |
| variation_id | variation_id | Nullable(UInt64) |
| visitor_id | visitor_id | String |
| session_id | session_id | String |
| event_name | event_name | LowCardinality(String) |
| url | url | String |
| referrer | referrer | String (default '') |
| country | country | LowCardinality(String) |
| region | region | LowCardinality(String) |
| region_subdivision | region_subdivision | LowCardinality(String) (default '') |
| city | city | LowCardinality(String) (default '') |
| device_type | device_type | LowCardinality(String) |
| browser | browser | LowCardinality(String) |
| os | os | LowCardinality(String) |
| viewport_w | viewport_w | UInt16 (default 0) |
| viewport_h | viewport_h | UInt16 (default 0) |
| tracker_version | tracker_version | LowCardinality(String) (default '') |
| is_bot | is_bot | UInt8 |
| consent_state | consent_state | LowCardinality(String) |
| utm_source | utm_source | LowCardinality(String) (default '') |
| utm_medium | utm_medium | LowCardinality(String) (default '') |
| utm_campaign | utm_campaign | LowCardinality(String) (default '') |
| value_native | value_native | Decimal(18, 4) (default 0) |
| currency | currency | LowCardinality(String) (default '') |
| order_id | order_id | String (default '') |
| items_count | items_count | UInt16 (default 0) |
| props | props | Map(LowCardinality(String), String) |

## Examples

### Pageview

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-1234567890ab",
  "event_name": "page_view",
  "client_ts": 1730902400123,
  "project_id": 42,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/products/widget?utm_source=google",
  "referrer": "https://google.com/",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1920,
  "viewport_h": 1080,
  "utm_source": "google"
}
```

### Experiment view

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "experiment_view",
  "client_ts": 1730902400500,
  "project_id": 42,
  "experiment_id": 17,
  "variation_id": 100,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/products/widget",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1920,
  "viewport_h": 1080
}
```

### Purchase

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "purchase",
  "client_ts": 1730906000000,
  "project_id": 42,
  "experiment_id": 17,
  "variation_id": 100,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/checkout/success",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 414,
  "viewport_h": 896,
  "utm_source": "email",
  "utm_campaign": "summer_sale",
  "value_native": 49.99,
  "currency": "USD",
  "order_id": "ORD-20260505-0042",
  "items_count": 2,
  "props": { "coupon": "SUMMER10" }
}
```

### Custom event

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "newsletter_signup",
  "client_ts": 1730902450000,
  "project_id": 42,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1440,
  "viewport_h": 900,
  "props": { "form_id": "footer_newsletter", "source": "blog_post" }
}
```

## Validation

- The pixel uses TS types (no runtime validation; smaller bundle).
- The edge worker validates at the boundary against a Zod schema mirroring the TS types. Rejects 400 with reason.
- The collector validates on `/_ingest` (defence in depth + replay protection).
- Schema mismatches in CH never happen at runtime because the consumer normalizes shapes before INSERT.

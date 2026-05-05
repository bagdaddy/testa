# Reference — HTTP endpoints

All HTTP surfaces of the platform, in one place.

## Edge worker (`apps/edge`)

Base URL: `https://testa-edge.workers.dev` (or customer's CNAME `track.{customer}.com`).

### `GET /projects/:slug.js`

Serves the pixel for a project.

```http
GET /projects/abc123.js HTTP/1.1
Host: track.example.com

200 OK
Content-Type: application/javascript; charset=utf-8
Cache-Control: public, max-age=60, stale-while-revalidate=300
Set-Cookie: _testa_uuid=v_xyz123; Domain=.example.com; Max-Age=63072000;
            Path=/; SameSite=Lax; Secure
ETag: "<config_hash>"

(function(){ /* loader */ })();
(function(){ /* runtime + window.cfPrefill */ })();
```

If `If-None-Match` matches the current `config_hash`, return 304.

If project doesn't exist or `integration_version` is null, return 404.

### `POST /track`

Accepts events from the pixel.

```http
POST /track HTTP/1.1
Host: track.example.com
Content-Type: application/json
Cookie: _testa_uuid=v_xyz123; _testa_ses=s_abc

{
  "events": [ /* PixelEvent[] */ ]
}

204 No Content
Set-Cookie: _testa_uuid=v_xyz123; ... (refresh)
Access-Control-Allow-Origin: *
```

CORS allowed from any origin (the customer's site is the caller). Credentials not used (cookies are first-party from the customer's perspective when in CNAME mode).

### `OPTIONS /track`

CORS preflight. Returns 204 with the standard CORS headers.

### `GET /health`

```http
GET /health HTTP/1.1

200 OK
Content-Type: application/json

{ "ok": true, "environment": "production" }
```

Used by uptime monitors. Not authenticated.

## Collector (`apps/collector`)

Base URL: `http://collector.testa.internal:8000` (internal-only; not exposed publicly).

### `POST /_ingest`

Accepts HMAC-signed batches from the edge worker.

```http
POST /_ingest HTTP/1.1
Content-Type: application/json
X-Edge-Signature: <hex-sha256-hmac>

{
  "signed_at": 1730902400123,
  "events": [ /* EnrichedEvent[] */ ]
}

204 No Content                         (success)
401 Unauthorized                       (bad signature)
400 Bad Request                        (replay window exceeded OR Zod fail)
```

See `docs/reference/hmac-protocol.md`.

### `GET /api/v1/metrics/aov`

```http
GET /api/v1/metrics/aov?experiment_id=42&from=2026-04-01&to=2026-05-01&report_currency=USD HTTP/1.1
X-Service-Token: <SERVICE_TOKEN>

200 OK
Content-Type: application/json

{
  "experiment_id": 42,
  "report_currency": "USD",
  "from": "2026-04-01",
  "to": "2026-05-01",
  "variations": [
    {
      "variation_id": 100,
      "aov": 49.99,
      "ci_low": 47.10,
      "ci_high": 52.88,
      "sample_size": 1234,
      "total_revenue": 61687.66,
      "orders": 1234
    }
  ],
  "significance": [
    {
      "reference_variation_id": 100,
      "compared_variation_id": 101,
      "delta": 4.21,
      "delta_relative": 0.084,
      "p_value": 0.024,
      "is_significant": true
    }
  ]
}
```

Default `from = now() - 30 days`, `to = now()`. `report_currency` defaults to USD.

### `GET /api/v1/metrics/rpv`

Same shape as aov but with `rpv` and `visitors` fields.

### `GET /api/v1/metrics/sessions`

```json
{
  "experiment_id": 42,
  "from": "2026-04-01",
  "to": "2026-05-01",
  "variations": [
    {
      "variation_id": 100,
      "sessions": 5432,
      "bounce_rate": 0.41,
      "pages_per_session": 2.7,
      "sample_size": 5432
    }
  ]
}
```

### `GET /api/v1/metrics/funnel`

```json
{
  "experiment_id": 42,
  "from": "2026-04-01",
  "to": "2026-05-01",
  "variations": [
    {
      "variation_id": 100,
      "sample_size": 5432,
      "steps": [
        { "event_name": "page_view",       "count": 5432, "rate_from_prev": 1.00 },
        { "event_name": "add_to_cart",     "count": 1234, "rate_from_prev": 0.227 },
        { "event_name": "checkout_start",  "count":  890, "rate_from_prev": 0.721 },
        { "event_name": "purchase",        "count":  654, "rate_from_prev": 0.735 }
      ]
    }
  ]
}
```

### `GET /api/v1/metrics/total_revenue`

```json
{
  "experiment_id": 42,
  "report_currency": "USD",
  "variations": [
    { "variation_id": 100, "total_revenue": 61687.66, "orders": 1234, "sample_size": 1234 }
  ]
}
```

### `GET /_internal/fx-rates`

ClickHouse dictionary source. Returns daily FX rates as `JSONEachRow`.

```
{"date":"2026-05-05 00:00:00","from_ccy":"EUR","to_ccy":"USD","rate":1.082}
{"date":"2026-05-05 00:00:00","from_ccy":"GBP","to_ccy":"USD","rate":1.262}
...
```

Not authenticated (CH internal pull). Restrict via network policy.

### `GET /_internal/health`

```http
200 OK
{ "ok": true, "service": "collector", "version": "0.0.0", "environment": "production" }
```

## Crobot proxy (`crobot`)

Base URL: existing crobot domain.

### `GET /api/experiments/{id}/metrics/{metric}`

Existing user-auth middleware (Sanctum). Proxies to collector with `X-Service-Token`. Caches 60 s in Redis.

```http
GET /api/experiments/42/metrics/aov?currency=USD HTTP/1.1
Authorization: Bearer <user-token>

→ Laravel auth/permission check
→ Cache lookup (60s)
→ MISS: HTTP GET http://collector:8000/api/v1/metrics/aov?experiment_id=42&report_currency=USD
                  X-Service-Token: <SERVICE_TOKEN>
→ Cache write
→ Response: same shape as collector

200 OK
{ "experiment_id": 42, ... }
```

### Existing legacy endpoints (unchanged)

These keep working as today; 4.0 pixel still calls them for back-compat.

- `POST /api/leads` — creates a Lead row in MySQL
- `POST /api/leads/convert` — records a goal conversion
- `GET /api/pixel` — Shopify Custom Pixel 1×1 GIF tracker
- `POST /api/marketing/create-lead` — marketing funnel email capture

See `crobot/routes/api.php` and `crobot/app/Http/Controllers/API/LeadController.php`.

## Versioning

- Edge endpoints: no version prefix; backwards-compatible only. Behavior changes are gated by per-project `integration_version`.
- Collector internal API: prefixed `/api/v1/`. Breaking changes bump the prefix.
- Crobot proxy: matches collector v1.

# Reference — Project config (CF KV)

The JSON object crobot publishes to Cloudflare KV per project. The edge worker reads it on every `GET /projects/:slug.js`. Inlined into the served pixel as `window.cfPrefill.project`.

## Source of truth

- **Owned by:** crobot (`projects`, `experiments`, `variations`, `goals`, `experiment_rules` tables in MySQL).
- **Published by:** `crobot/app/Domain/Analytics/Jobs/PublishProjectConfigToKV.php`, dispatched by `ProjectConfigObserver` on Eloquent saved/deleted events.
- **Stored at:** CF KV namespace `KV_PROJECT_CONFIG`, key `project_config:{slug}`.
- **Consumed by:** `apps/edge/src/index.ts` GET `/projects/:slug.js` handler.
- **Type:** `ProjectConfig` in `packages/shared-types/src/project-config.ts`.

## Shape

```json
{
  "project_id": 42,
  "slug": "abc123",
  "integration_version": "4.0",
  "consent_mode": "aware",
  "tracking_domain": "track.example.com",
  "experiments": [
    {
      "experiment_id": 17,
      "status": "active",
      "traffic_allocation": 100,
      "rules": [
        { "match_type": "contains", "url_pattern": "/products/" }
      ],
      "audience": {
        "all": [
          { "fact": "device.type",  "op": "in", "value": ["mobile", "tablet"] },
          { "fact": "geo.country",  "op": "in", "value": ["US", "CA"] }
        ]
      },
      "frequency_cap": { "max": 3, "window": "week" },
      "mutex_group": "checkout_optimization",
      "variations": [
        {
          "variation_id": 100,
          "weight": 50,
          "changes": []
        },
        {
          "variation_id": 101,
          "weight": 50,
          "changes": [
            {
              "type": "css",
              "selector": ".buy-button",
              "styles": { "background-color": "#ff6600" }
            },
            {
              "type": "text",
              "selector": ".buy-button",
              "text": "Get yours now"
            }
          ]
        }
      ],
      "goals": [
        { "goal_id": 1, "type": "page_view", "match_type": "exact", "action": "/checkout/success" },
        { "goal_id": 2, "type": "click", "action": ".add-to-cart" }
      ]
    }
  ],
  "published_at": "2026-05-05T17:30:00.000Z",
  "config_hash": "a1b2c3d4e5f6"
}
```

## Field semantics

### `integration_version`

Determines which JS bundle the worker serves. Drives drop-in compatibility.

- `'3.4'` — frozen legacy script. Worker serves `integration_bundle:3.4` from KV. Pixel ignores `experiments[]` (3.4 has its own loader).
- `'3.6'` — frozen legacy script. Same as above.
- `'4.0'` — TS-built loader + runtime. Reads `experiments[]` directly.

### `consent_mode`

- `'aware'` — pixel fires by default with `consent_state: 'granted'`. Customer's CMP can change it. Default.
- `'strict'` — pixel waits for explicit `_testa.consent('granted')` before firing anything. For customers in jurisdictions with strict opt-in requirements.

### `tracking_domain`

Optional. If present and the worker request's `Host` header matches `track.{tracking_domain}`, cookies are set with `Domain=.{tracking_domain}` (first-party). If absent, cookies fall back to `Domain=.testa.com` (third-party).

### `audience`

Optional. New in 4.0. Tree of `AudienceCondition` boolean rules over typed dimensions. Evaluated client-side by the pixel rule engine. If absent, the experiment matches every visitor (subject to `traffic_allocation`).

Full schema in `docs/reference/audience-schema.md`. Backwards compat: legacy `targeting[]` shape (3.3.x/3.6) is honored when `audience` is missing.

### `traffic_allocation`

0–100. Percentage of eligible visitors who participate. Remaining are excluded (`_testa_excl` cookie set).

### `frequency_cap`

Optional. New in 4.0. Caps how many times a visitor sees this experiment within a rolling window:

```ts
frequency_cap?: {
  max: number;
  window: 'session' | 'day' | 'week' | 'month';
}
```

- `max`: count of `experiment_view` fires before the visitor is excluded.
- `window`: rolling window. `'session'` means until the session cookie expires; the others are calendar windows.
- Counter is persisted in `_testa_freq_<experiment_id>` cookie; resets when the window elapses.

If absent, no cap is applied.

### `mutex_group`

Optional. New in 4.0. A free-text group name. A visitor can be in **at most one** active experiment per `mutex_group` value. Once enrolled, subsequent experiments sharing the same group will skip enrollment for that visitor (no `experiment_view`, no variation applied).

```ts
mutex_group?: string;   // e.g. "checkout_optimization"
```

Persisted in `_testa_mutex_<group_name>` cookie holding the assigned `experiment_id`.

If absent, no mutex constraint.

### `weight`

Per-variation weight for traffic distribution. Sum across active variations should equal 100. The pixel uses **deterministic xxhash32 bucketing**: `xxhash32(visitor_id + ':' + experiment_id, seed=0xABCDEF) % 100`. Same visitor + same experiment always produces the same bucket — eliminates the SRM (Sample Ratio Mismatch) drift seen with `Math.random()`-based bucketing in 3.6.

### `changes`

Array of `VariationChange` objects. Discriminated union by `type`:

- `{ type: 'css', selector, styles }`
- `{ type: 'html', selector, html }`
- `{ type: 'text', selector, text }`
- `{ type: 'js', code }`
- `{ type: 'redirect', from_url, to_url }`
- `{ type: 'attribute', selector, name, value }`

The 4.0 pixel applies these in order, on `DOMContentLoaded` and on subsequent mutations matching the selector (MutationObserver-based, same approach as 3.6).

### `published_at` and `config_hash`

- `published_at` — ISO timestamp of the publish job execution. Diagnostic only.
- `config_hash` — first 12 hex chars of `sha256(JSON.stringify(experiments_array))`. Used for:
  - The served JS URL: `/projects/{slug}.js?h={config_hash}` (cache invalidation).
  - The `ETag` response header on `GET /projects/:slug.js`.

When crobot republishes (any change to experiments/variations/goals/rules), `config_hash` changes, which busts the customer's cached pixel.

## Publish lifecycle

```
Filament admin saves Experiment 17
    ↓
Eloquent saved event fires
    ↓
ProjectConfigObserver dispatches PublishProjectConfigToKV(project_id=42)
    ↓ (Horizon queue, tries=5, exp backoff)
Job runs:
    1. Eager-load project + experiments + variations + goals + rules
    2. Build the JSON above
    3. Compute config_hash
    4. CloudflareKvService::putProjectConfig(slug, json)
    5. PUT https://api.cloudflare.com/client/v4/accounts/{id}/storage/kv/namespaces/{ns}/values/project_config:{slug}
       Content-Type: application/json
       Authorization: Bearer <CF_API_TOKEN>
    6. CF propagates globally (~10 seconds)
    ↓
Worker reads on next GET /projects/{slug}.js
```

## Backfill

`crobot/app/Console/Commands/Analytics/PublishAllConfigsCommand.php`:

```php
php artisan analytics:publish-all-configs
```

Iterates every project in MySQL, dispatches `PublishProjectConfigToKV` for each. Used:

- After deploying the analytics infra to bootstrap KV.
- Periodically as a sanity check (cron weekly).

## Failure modes

- **CF API down.** Job retries with exp backoff. After max tries, lands in `failed_jobs` and pages oncall. Worker continues serving the previous KV value.
- **Stale KV.** If the publish job fails silently, customer's pixel might serve stale config for up to 24h before next backfill. Mitigated by alerting on job failures.
- **Slug collision.** Project slugs are unique by DB constraint. KV key collision is impossible.
- **Hash collision on `config_hash`.** 12 hex chars = 48 bits. Birthday collision at ~16M configs per project. Not a concern.

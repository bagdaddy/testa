# Architecture — Rollout & versioning

## Drop-in compatibility is sacred

The 4.0 tracker must replace 3.6 **without customers changing their HTML**. Every customer integration today looks like:

```html
<script src="https://{their-tracking-host}/projects/{slug}.js"></script>
```

This URL must keep working. Same path. Same MIME. Same headers. The script we serve from this URL is what changes (per project setting).

## Per-project version flag

Crobot adds a column `projects.integration_version` (`enum('3.4','3.6','4.0')`, default `'3.6'` for existing rows, `'4.0'` for new projects).

When the worker handles `GET /projects/:slug.js`, it reads `project_config:{slug}` from KV (which contains `integration_version`) and serves the matching bundle.

```
KV_INTEGRATION_BUNDLES:
  integration_bundle:3.4   →  legacy 3.4/script.js (frozen, served as-is)
  integration_bundle:3.6   →  legacy 3.6/script.js (frozen, served as-is)
  integration_bundle:4.0   →  loader.min.js + runtime.min.js (built from apps/pixel)
```

3.4 and 3.6 bundles are uploaded once at migration time from the existing crobot `resources/js/integration/3.{4,6}/script.js`. They're frozen. We never edit them again.

## Behavioral parity — the contract

4.0 must, for any project flagged 4.0:

1. **Continue calling `POST /api/leads`** when a variation is applied. Crobot's `LeadController` writes the row to MySQL exactly as today. `CacheExperimentService` keeps working.
2. **Continue calling `POST /api/leads/convert`** when a goal converts. Same as today.
3. **Continue calling `GET /api/pixel`** for Shopify Custom Pixel events. Same as today.
4. **Expose all the same legacy globals**: `window.crbData`, `window.apiUrl`, `window.testa_env`, `window.Analytica.eventEmitter`, `window.Analytica.UUID_COOKIE`, etc.
5. **Apply experiments identically** — same rule semantics, same traffic allocation, same DOM mutations, same redirect/copy bugs (1:1 port; redirects and copy tests are tracked as post-pilot follow-ups).
6. **Fire the same legacy events** to listeners (`variation_applied`, `variation_assigned`, `pageshow`).

In addition, 4.0:

7. Emits new events to `POST /track` at the edge worker.
8. Listens for `_testa.consent(...)`.
9. Exposes new public API: `_testa.track`, `_testa.trackPurchase`.

## Pilot → general rollout sequence

### Stage 1 — Land infra (no customer impact)

1. testa-platform deployed: collector + edge worker running. ClickHouse provisioned. Redis Stream live.
2. Crobot side merged: `Domain/Analytics/`, `MetricsProxyController`, new project columns. Default `integration_version = '3.6'` for everyone.
3. Backfill `analytics:publish-all-configs` artisan command pushes every project to KV. Worker now serves all customers (still 3.6 bundle).
4. **Verify nothing changed.** Existing customers continue hitting the worker (which serves 3.6 unchanged). MySQL stats path unchanged.

### Stage 2 — Pilot

5. Pick a low-traffic project (ours or a friendly customer). Flip `integration_version = '4.0'`.
6. Observe for 14 days:
   - **Parity check** (cron, daily): MySQL `leads` row count for experiment X within 1% of CH `uniqExact(visitor_id) WHERE event_name='experiment_view' AND experiment_id=X`. Slack alert on divergence.
   - **Sentry**: zero new exception classes from `runtime.js` / `loader.js` (source maps uploaded).
   - **Dashboards**: AOV/RPV computed in Vue components, sanity-checked against the customer's known revenue.
   - **CH ingest health**: p99 INSERT < 1 s, Redis Stream lag < 5 s, edge worker error rate < 0.1%.

### Stage 3 — Internal batch

7. Internal customer batch (~10 projects). 1 week observation.

### Stage 4 — Full rollout

8. Remaining customers in batches of ~50. Monitor for unexpected event volume; CH should comfortably handle 10× current traffic.

### Stage 5 — CNAME upsell

9. First-party tracking opt-in marketed to customers. Self-serve setup: project setting + DNS instructions + verification check.

## What the user sees in crobot admin

```
Project Settings  ►
  Integration version           ●  3.6 (legacy)    ○  4.0 (recommended)
  Report currency               [USD ▾]
  First-party tracking domain   [empty]   [How to set up CNAME →]
  Consent mode                  ●  Aware    ○  Strict
```

The `4.0 (recommended)` option is gated by feature flag during pilot. Once we batch-roll, the flag flips per cohort.

## Rollback

If 4.0 causes a regression:

1. **Per-project rollback (instant).** Flip `integration_version = '3.6'`. Eloquent observer fires, KV updated, worker starts serving 3.6 within ~10 seconds. Customer's site picks it up on next pageview (cache-busted via content hash).
2. **Full rollback.** Backfill all projects to `integration_version = '3.6'`. Same mechanism, just every project at once.

No customer needs to change HTML. No DNS changes. No deploy.

## In scope (where earlier drafts of this doc deferred to v2 / post-pilot)

These were considered for "later" in earlier drafts; subsequent architecture grilling pulled them forward into the current redesign because shipping without them would put us behind VWO/ABTasty out of the gate.

- **Redirect engine rework.** State-of-the-art. SPA + Next.js compatibility, query-param fidelity, loop guard, cross-domain visitor stitching. Specifics in `docs/architecture/01-tracker.md` § Redirect engine. Repro harness across Next 12/13/14 and react-router-dom 6 lands with the engine.
- **Audience targeting upgrade.** Tier 1 + Tier 2 dimensions (geo, device, browser, OS, language, time, referrer, query param, cookie, isReturning, dataLayer, custom JS) under a nestable `all`/`any`/`not` JSON schema. See `docs/reference/audience-schema.md`. Sandboxed expression language for `visitor.custom`; no real `eval`.
- **IndexedDB-backed event outbox + `_pixel_health` observability.** Durable retry queue, force-flush on pagehide, `SETNX`-before-`XADD` idempotency on the collector. Specifics in `docs/architecture/01-tracker.md` § Event delivery and `docs/architecture/02-collector.md` § Idempotency.
- **`window.Analytica.*` legacy global surface.** Frozen API for drop-in compat with 3.x customers. See `docs/reference/legacy-pixel-mapping.md` and `docs/reference/legacy-globals-inventory.md`.
- **Per-experiment frequency cap + mutex groups.** Tier-2 audience features built into experiment config: `frequency_cap: { max, window }` and `mutex_group: string`. See `docs/reference/project-config-shape.md`.

## Tracked follow-ups (truly post-pilot)

- **Copy-test improvements.** 4.0 ships the 1:1-port behavior; rework after rollout once we have a pilot's worth of regression data.
- **Migrating away from `leads` / `lead_completed_goals`.** They stay in v1; CH coexists.

## Edge worker deployment model — per-customer workers

testa-platform deploys **one Cloudflare Worker per customer** (named e.g. `testa-edge-{customer_slug}`). Customer signup triggers a `ProvisionEdgeWorker` job in crobot that programmatically deploys a worker from a wrangler template, with bindings + secrets pre-configured. Customer's CNAME (`track.{customer-domain}`) points to their dedicated worker.

This gives:

- **Failure isolation.** A bug in one customer's KV config or a customer-induced traffic spike stays in their worker; CF auto-scales them independently and bills them for it.
- **Zero noisy-neighbor concerns at the edge.** Each customer is on their own runtime instance pool.
- **No technical rate limiting.** The product applies rate limiting **as little as possible**. Customer's monthly lead-creation quota in crobot is the only meaningful "cap" and that's billing-level, not operational. Collector keeps a **circuit breaker** (Redis stream depth threshold → 503) for catastrophic protection of shared infra, but no per-project caps.

The shared `testa-edge` deployment serving `track.testa.com` becomes the **fallback / shared-domain mode** for customers without CNAME setup (third-party cookies; pre-CNAME onboarding).

A new task corpus (Phase 6) will scope the worker provisioning workflow + CI fan-out for code updates across all customer workers.

## Optional / premium offerings

- **CNAME-edge with worker-decided redirect/audience.** Customers can opt into having the dedicated worker serve sync redirect JS for first-pageload zero-flicker. Most customers stick with pixel-decided (the default and 99% of integrations). See `docs/architecture/01-tracker.md` § Integration model.

## Out of scope for this redesign

- ClickHouse replication / HA. Single node is enough today; revisit when traffic dictates.
- Customer-configurable retention. Whole-table TTL only.
- Edge personalization (server-rendered variations). Different product.
- Generic web-analytics product surface (pageviews UI without an experiment context).
- Cloudflare Bot Management paid feature. Free signals + heuristics only.
- Pulling testa-agent or testa-marketing-web into the new monorepo.

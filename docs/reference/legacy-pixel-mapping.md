# Reference — Legacy 3.6 → 4.0 mapping

A mapping table for porting 3.6 behavior into 4.0 modules. **This is the contract for the 1:1 port** in Phase 3.7. Any 3.6 behavior not on this list is either out of scope or a bug to preserve.

> **Source file:** `crobot/resources/js/integration/3.6/script.js` (~1315 lines, frozen).
> **Source bug catalog (informal):** see crobot internal issues; we do not enumerate the specific bugs here.

## Globals exposed by 4.0 (drop-in compat)

| 3.6 global | 4.0 module | Notes |
|---|---|---|
| `window.crbData` | `runtime/legacy.ts` | Project config object expected by old customer integrations. 4.0 builds this from `window.cfPrefill.project`. |
| `window.apiUrl` | `runtime/legacy.ts` | Crobot API base URL. 4.0 reads from `window.cfPrefill.apiUrl`. |
| `window.testa_env` | `runtime/legacy.ts` | 'production' / 'staging'. From `window.cfPrefill.env`. |
| `window.Analytica` | `runtime/legacy.ts` | Object with cookies map, event emitter, etc. 4.0 mirrors all properties. |
| `window.Analytica.eventEmitter` | `runtime/events.ts` (re-exposed via legacy) | 3.6 listeners must keep working. |
| `window.Analytica.UUID_COOKIE` | `runtime/cookies.ts` | Cookie name constant: `_testa_uuid`. |
| `window.Analytica.COOKIE_NAME` | `runtime/cookies.ts` | Cookie name constant: `_testa_exp`. |
| `window.Analytica.SESSION_COOKIE` | `runtime/cookies.ts` | Cookie name constant: `_testa_ses`. |
| `window.Analytica.SESSION_LENGTH` | `runtime/cookies.ts` | 1 hour. |
| `window.Analytica.cookies[experimentId]` | `runtime/experiments/traffic.ts` | Cached variation per experiment. |
| `window._testa` | `runtime/index.ts` (new in 4.0) | New API surface. Coexists with legacy. |

## Legacy events fired by 4.0

3.6 event listeners must keep working unchanged. 4.0 fires the same events in the same order at the same lifecycle points.

| 3.6 event | When | 4.0 module |
|---|---|---|
| `variation_assigned` | Experiment config loaded; variation chosen | `runtime/experiments/traffic.ts` |
| `variation_applied` | Variation DOM changes applied | `runtime/experiments/apply/index.ts` |
| `pageshow` (with `persisted=true` log) | bfcache restore | `runtime/network.ts` |

## Legacy HTTP calls by 4.0

| 3.6 call | When | 4.0 keeps doing this? |
|---|---|---|
| `POST /api/leads` | Variation applied | **YES.** Calls existing `LeadController` exactly as today. Crobot writes Lead row. |
| `POST /api/leads/convert` | Goal triggered | **YES.** Calls existing endpoint. |
| `GET /api/pixel?...` | Shopify Custom Pixel events | **YES.** 4.0 forwards Shopify events identically. |

Plus, 4.0 ALSO emits to `POST /track` at the edge worker (additive).

## Experiment runtime — what to preserve

### Rule matching (`runtime/experiments/rules.ts`)

3.6 has these match types. Replicate semantics exactly:

- `exact` — `url === pattern`
- `contains` — `url.includes(pattern)`
- `not_contains` — `!url.includes(pattern)`
- `regex` — `new RegExp(pattern).test(url)`

The URL the rule matches against is `window.location.href` minus fragment, with the trailing `/` and case-sensitivity rules from 3.6 (preserve them; do not normalize away).

### Traffic allocation (`runtime/experiments/traffic.ts`)

3.6 uses a hash-of-visitor-id mod 100 to assign within `traffic_allocation`. Replicate the exact hash function (it's a simple 32-bit FNV variant in 3.6 — port it byte-for-byte). A different hash would re-assign visitors mid-experiment when migrating from 3.6 to 4.0, breaking integrity.

### Visual changes (`runtime/experiments/apply/`)

| 3.6 mechanism | 4.0 module | Preserve |
|---|---|---|
| CSS injection via `<style>` element | `apply/css.ts` | Selector targeting; specificity rules. |
| HTML swap via `innerHTML` | `apply/html.ts` | Multi-element via `querySelectorAll`. |
| Text replacement | `apply/text.ts` | **Including known text-traversal bugs.** Do not "fix" anything. Tracked as post-pilot follow-up. |
| Custom JS via `eval` (in the runtime context) | `apply/js.ts` | Yes — preserve the eval. We're not making it safer in v1. |
| Element attribute set | `apply/attribute.ts` | `el.setAttribute(name, value)` |
| **Split URL redirect** | `apply/redirect.ts` | **Including known redirect bugs.** Do not "fix". Tracked as post-pilot follow-up. |
| Cross-domain link tagging | `apply/cross_domain.ts` | The `_testa_cd` URL parameter passed to whitelisted domains. |

### MutationObserver (`runtime/experiments/observer.ts`)

3.6 watches the DOM for additions and re-applies variations to newly-added matching nodes. Port the observer setup including its debouncing.

### bfcache handling

`pageshow` with `event.persisted === true` triggers a re-check of session cookies. 3.6 logs this. 4.0 does the same.

## Cookies — semantic compat

| Cookie | 3.6 behavior | 4.0 behavior |
|---|---|---|
| `_testa_uuid` | JS-set via `document.cookie`, no Domain → host-only, ~lifetime year (capped 7d on Safari ITP) | **Server-set by edge worker** with `Domain=.{tracking_domain}` if CNAME, else `Domain=.testa.com`; Max-Age=2y. JS only reads. |
| `_testa_ses` | JS-set, 1h sliding | Same. JS-managed. |
| `_testa_exp` | JS-set, 30d, JSON-encoded experiment assignments | Same. |
| `_testa_excl` | JS-set, 30d, marker for excluded visitors | Same. |
| `_testa_user` | JS-set (new in 3.6, used for some integrations) | Same. |

The `_testa_uuid` change is the load-bearing one for ITP defeat.

## Cross-domain (`_testa_cd` URL parameter)

3.6 tags outbound links to whitelisted domains with `?_testa_cd=<encoded experiment+variation+uuid>`. The destination site's pixel reads it on landing and applies the experiment without re-rolling traffic.

4.0 module: `runtime/experiments/cross_domain.ts`. Preserve the encoding format exactly so 3.6 and 4.0 sites can interoperate during the rollout window.

## Behaviors NOT to copy

The following 3.6 behaviors are explicitly NOT carried into 4.0:

- Direct `document.cookie = '_testa_uuid=...'` writes. The worker owns this cookie now.
- jQuery dependency (3.6 has hidden `$` references in custom JS hooks). 4.0 is jQuery-free; if customer custom JS expects `$`, they keep getting whatever jQuery their own page provides.

## Test parity

`apps/pixel/e2e/3-6-parity.spec.ts` (Phase 3.10) loads the same fixture page with 3.6 vs 4.0 in two browser contexts and asserts identical:

- Cookies set
- Network requests fired (URL + body shape)
- DOM mutations applied
- Event emitter callbacks fired (in order)

Any divergence is a bug to fix in 4.0, NOT in 3.6. 3.6 stays frozen.

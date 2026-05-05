# Reference — `window.Analytica.*` legacy globals inventory

Complete enumeration of the `window.Analytica` surface exposed by `crobot/resources/js/integration/3.6/script.js`. The 4.0 pixel **must mirror every entry** so customers' code that references these symbols continues to work.

> Source: `crobot/resources/js/integration/3.6/script.js` (1315 lines, frozen). Inventory taken 2026-05-06.
> Companion doc: `docs/reference/legacy-pixel-mapping.md` (which 4.0 module owns each surface).

## Constants (read-only after load)

| Field | Value | Purpose | 4.0 module |
|---|---|---|---|
| `Analytica.COOKIE_NAME` | `"_testa_exp"` | Per-experiment variation cookie name prefix | `runtime/cookies.ts` |
| `Analytica.SESSION_COOKIE` | `"_testa_ses"` | Per-experiment session cookie name prefix | `runtime/cookies.ts` |
| `Analytica.USER_COOKIE` | `"_testa_user"` | Per-experiment first-time-seen cookie name prefix | `runtime/cookies.ts` |
| `Analytica.UUID_COOKIE` | `"_testa_uuid"` | Persistent visitor UUID cookie name | `runtime/cookies.ts` |
| `Analytica.EXCLUDED_COOKIE` | `"_testa_excl"` | Per-experiment exclusion cookie name prefix | `runtime/cookies.ts` |
| `Analytica.CROSS_DOMAIN_PARAM` | `"_testa_cd"` | URL param name for cross-domain visitor stitching | `runtime/experiments/redirect/cross-domain.ts` |
| `Analytica.SESSION_LENGTH` | `60 * 60 * 1000` (ms) | Session inactivity window | `runtime/cookies.ts` |
| `Analytica.CLICK_SELECTOR_TIMEOUT` | `100` (ms) | Polling interval for click-goal selector | `runtime/experiments/apply/index.ts` |
| `Analytica.CLICK_SELECTOR_MAX_TRIES` | `3` | Max retries on click selector | `runtime/experiments/apply/index.ts` |
| `Analytica.NEXTJS_TIMEOUT_MS` | `1000` (ms) | Max wait for Next.js content load | `runtime/spa.ts` |
| `Analytica.NEXTJS_CHECK_INTERVAL` | `50` (ms) | Polling interval inside Next.js wait | `runtime/spa.ts` |
| `Analytica.VARIATION_APPLIED_KEY` | `"variation_applied"` | Event name fired when variation DOM applied | `runtime/experiments/apply/index.ts` |
| `Analytica.VARIATION_ASSIGNED_KEY` | `"variation_assigned"` | Event name fired when variation chosen | `runtime/experiments/traffic.ts` |
| `Analytica.headers` | `{ "Content-Type": "application/json", Accept: "application/json" }` | HTTP headers for legacy `/api/leads` calls | `runtime/legacy.ts` |

## Configuration (set once, read throughout)

| Field | Source | Purpose |
|---|---|---|
| `Analytica.domain` | `window.cfPrefill.apiUrl` ?? `window.apiUrl` | Tracking API base URL |
| `Analytica.environment` | `window.cfPrefill.env` ?? `window.testa_env` | `'production'` / `'staging'` |
| `Analytica.geoData` | `window.cfGeoData ?? {}` | CF-derived geo (country, region) |
| `Analytica.project` | `window.cfPrefill.project` ?? `window.crbData` | Full project config — experiments + variations + goals + rules |
| `Analytica.isNextApp` | Detected from `window.__NEXT_DATA__` / `#__next` / `[data-reactroot]` / `script[src*="/_next/"]` | Whether the host page is a Next.js app — affects SPA wait behavior |
| `Analytica.spa` | Set externally by some integrations to `1` for SPA mode | `1` ⇒ pixel runs in SPA mode (history-patched) |
| `Analytica.lsEnabled` | Defaults `1` | `0` to disable localStorage usage (privacy fallback) |
| `Analytica.nextContentLoaded` | Defaults `true`, customers can override to `false` to gate processing on a manual flag | Synchronization point for Next.js apps that finish hydration after initial render |

## Mutable state

| Field | Type | When mutated | Purpose |
|---|---|---|---|
| `Analytica.uuid` | string | After `_testa_uuid` cookie read or generated | Current visitor's persistent ID |
| `Analytica.url` | string | Set on each runtime entry to `window.location.href` | URL the runtime is currently evaluating |
| `Analytica.cookies` | `Record<experimentIdentifier, variationIdentifier>` | Updated on assignment, restoration from cookie | Cached per-experiment variation assignments |
| `Analytica.ses` | `Record<experimentIdentifier, sessionExpiryMs>` | Updated on session activity | Per-experiment session timestamps |
| `Analytica.usr` | `Record<experimentIdentifier, firstSeenMs>` | Set first time visitor sees an experiment | Per-experiment first-seen timestamps |
| `Analytica.excl` | `Record<experimentIdentifier, 0|1>` | Set when targeting decides this visitor is excluded | Per-experiment exclusion cache |
| `Analytica.sent` | `Record<experimentIdentifier, 0|1>` | Set after a `lead` POST succeeds | Dedup flag preventing double-send per experiment |
| `Analytica.isLoaded` | boolean | Flips true after first `r.init()` cycle | **DEPRECATED** but referenced; kept for compat |
| `Analytica.isRedirecting` | boolean | True for the duration of a redirect | Prevents further processing while a redirect fires |
| `Analytica.processing` | `0 \| 1` | True while `r.init()` is mid-cycle | Reentrancy guard |
| `Analytica.listeners` | `Array<[eventName: string, handler: Function]>` | Mutated by `eventEmitter.on()` | Subscriber list for the event bus |

## Methods / objects

| Field | Signature | Purpose |
|---|---|---|
| `Analytica.eventEmitter` | `{ emit(name, data), on(name, handler), eventHistory, handlerProcessedEvents, _processEvent, _processHistoryForHandler }` | Event bus. Replays history to late subscribers. Customers' `Analytica.eventEmitter.on(...)` calls are common in integrations. |
| `Analytica.pushEvent` | `(name: string, data?: object) => void` | Custom event sink — visits each experiment's `goals[]`, fires `createConversion` if a goal type=`'custom'` matches by name. Customers call this directly from their app code. |

## Companion legacy globals

| Global | Purpose |
|---|---|
| `window.crbData` | Legacy project config (replaced by `cfPrefill.project` when CF worker serves the pixel) |
| `window.apiUrl` | Legacy tracking API base URL (replaced by `cfPrefill.apiUrl`) |
| `window.testa_env` | Legacy environment string (replaced by `cfPrefill.env`) |
| `window.cfGeoData` | CF-set geo prefill |
| `window.cfPrefill` | `{ project, apiUrl, env }` — set inline by the worker before the script loads |
| `window.testaLoaded` | Defaults to `false`. Flipped by 3.6 in some path; we mirror but don't rely on it |

## Customer-extension surface (must not break)

These are observable patterns customer integrations use today:

```js
// Pattern A — listen for variation events
window.Analytica.eventEmitter.on('variation_applied', (data) => {
  // data: { experiment: <id>, variation: <id>, ... }
  dataLayer.push({ event: 'experiment_view', ...data });
});

// Pattern B — fire custom goal events
window._testa_track_signup = () => window.Analytica.pushEvent('signup');

// Pattern C — read current visitor uuid
const uid = window.Analytica.uuid;

// Pattern D — early opt out of localStorage
window.Analytica.lsEnabled = 0;

// Pattern E — wait for the pixel to finish before showing content
//   (transitional pre-SmartCode pattern; customers will move to _testa.load() in 4.0)
const wait = setInterval(() => {
  if (window.Analytica.isLoaded) {
    document.body.style.visibility = 'visible';
    clearInterval(wait);
  }
}, 16);
```

## 4.0 implementation contract

The 4.0 runtime exports a `legacy` module that:

1. **Constructs `window.Analytica`** with every constant + every mutable field (initialized to the right empty value).
2. **Wires `eventEmitter` and `listeners`** to the same bus the new `_testa.track` API uses, so customers' `Analytica.eventEmitter.on('variation_applied', ...)` keeps firing at the right moments.
3. **Continues to fire `'variation_applied'` and `'variation_assigned'`** in the same order at the same lifecycle points as 3.6.
4. **Exposes `Analytica.pushEvent`** wired to the new track pipeline — but also still triggers the legacy `goals[]` `createConversion` path for `type: 'custom'` goals, since crobot's `LeadController` expects those rows.
5. **Mirrors `Analytica.cookies`, `.ses`, `.usr`, `.excl`, `.sent`, `.uuid`** as live mutations whenever the new runtime updates the canonical state. They're not just initial values — they need to stay in sync.
6. **Detects Next.js the same way** and respects `Analytica.nextContentLoaded` if customers have overridden it.
7. **Keeps `Analytica.isRedirecting` truthy for the duration of a redirect** so any customer code reading it gets the right answer.
8. **Treats `Analytica.isLoaded`** as deprecated-but-set: flips to `true` after the first init cycle. New code should listen for `_testa.load()` (Promise) instead, but `isLoaded` must still flip.

Tests in `apps/pixel/src/__tests__/legacy-globals.test.ts` should assert that every field in this table exists on `window.Analytica` after the runtime loads, with the right type and the right initial value where applicable.

## Adding a new field

If a future change introduces a new `window.Analytica.*` field:

1. Add it to this inventory.
2. Add the field to `apps/pixel/src/runtime/legacy.ts`.
3. Add an assertion in `legacy-globals.test.ts`.
4. Note it in the next agent run log so the routine flags any cross-version regression.

Removing fields requires a deprecation cycle: the global must keep working for ≥6 months from the deprecation announcement, with a `console.warn` indicating the replacement.

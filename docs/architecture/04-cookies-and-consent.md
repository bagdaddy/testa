# Architecture — Cookies & consent

## The problem we're solving

**Safari ITP** caps `document.cookie` (JS-set cookies) at 7 days and enforces aggressive third-party cookie blocking. **Firefox ETP** does similar via Total Cookie Protection. The current 3.6 pixel sets `_testa_uuid` via `document.cookie`, so a "returning visitor 30 days later" appears as a fresh visitor on Safari — destroying any cohort metric (AOV, RPV) that depends on visitor continuity.

The fix industry-wide (VWO, Optimizely, AB Tasty, Convert, PostHog, Plausible, Fathom): a server proxy on the customer's domain that sets `_testa_uuid` via `Set-Cookie` from a **first-party context**. JS is forbidden from setting it.

## Two cookie modes

### Shared domain (default, "good enough" mode)

```
Browser → https://track.testa.com/projects/foo.js → Worker
             ↑ cookies set here are third-party from customer's site
```

Worker sets `Set-Cookie: _testa_uuid=...; Domain=.testa.com; Max-Age=63072000; SameSite=Lax; Secure`. Cookie persists on Chrome / older browsers but Safari and Firefox classify it as third-party and block / shorten.

Acceptable for many customers. New projects default here.

### CNAME first-party mode (opt-in)

```
Browser → https://track.{customer-domain}/projects/foo.js → CNAME → Worker
             ↑ cookies set here are first-party from customer's site
```

Customer adds DNS:

```
track.{customer-domain}.   CNAME   testa-edge.workers.dev.
```

Worker recognizes the host (matched against the project's `tracking_domain` setting) and sets `Set-Cookie: _testa_uuid=...; Domain=.{customer-domain}; Max-Age=63072000; SameSite=Lax; Secure`.

**Cookie is first-party from the customer's site. Survives ITP. 2-year persistence.**

The customer decides per-project. We expose a "First-Party Tracking" setting in the Filament admin with copy/paste DNS instructions.

## Cookie inventory

| Cookie | Set by | Max-Age | Purpose | First-party? |
|---|---|---|---|---|
| `_testa_uuid` | Worker (Set-Cookie) | 2 years | Persistent visitor id | Depends on mode |
| `_testa_ses` | Pixel JS (document.cookie) | 1 hour sliding | Session id (TTL refreshes on activity) | Always (same eTLD+1) |
| `_testa_exp` | Pixel JS (document.cookie) | 30 days | Experiment assignment cache | Always |
| `_testa_excl` | Pixel JS (document.cookie) | 30 days | Excluded visitors (rule-based bypass) | Always |

Why `_testa_ses` and `_testa_exp` stay JS-set: they're per-session / per-experiment ephemeral. The 7-day ITP cap matters less than for `_testa_uuid` (persistence is the headline win).

## Consent

We are **consent-aware but not gated**. The pixel always fires; what changes is what we persist and for how long.

### Default state: `granted`

Matches GA4's default. Fits the most common customer integration (no CMP, or CMP-after-load).

### Customer signals via API

```js
window._testa.consent('granted')   // default
window._testa.consent('denied')    // anonymize
window._testa.consent('unknown')   // partial: persist visitor_id but mark
```

Or via DOM event (CMP integration):

```js
window.dispatchEvent(new CustomEvent('cmp:consent-changed', { detail: 'denied' }));
```

Pixel listens for this event and routes it to the consent module.

### What changes per state

| Behavior | granted | unknown | denied |
|---|---|---|---|
| `_testa_uuid` cookie set | Yes (2y) | Yes (2y) | **No** (Max-Age=0) |
| `visitor_id` derivation | from `_testa_uuid` | from `_testa_uuid` | **rotated daily**: `SHA-256(salt_of_day || ip || ua)` |
| IP forwarded to collector | yes | yes | **truncated** (last octet IPv4 / last 80 bits IPv6) |
| `consent_state` field in CH | 'granted' | 'unknown' | 'denied' |

Daily-rotating `visitor_id` means a denied visitor cannot be tracked across days. Within a day they're consistent (so bounce/sessions work for that day). After UTC midnight they get a fresh id.

The salt rotation: a random `VISITOR_ID_SALT` env var on the worker plus the UTC date string, both fed into SHA-256. The salt is rotated yearly via a wrangler secret update. Salt is never persisted alongside the hash, so even if CH is leaked, original ids cannot be recovered.

## Privacy / compliance posture

- **Roles.** Customer is data controller. We are processor (per DPA, mirrors VWO/Optimizely/AB Tasty industry baseline).
- **Retention.** 13 months on raw events (CH TTL on partition); aggregates indefinite. Aligns with CNIL recommendation for analytics with consent.
- **Data subject requests.** Per DPA, customer routes deletion / export requests; we honour them by `visitor_id`. With denied-state daily rotation, denied-visitor data is automatically forgotten after 1 day in any practical sense.
- **No PII in events.** `value_native`, `order_id`, `items_count`, `props` are not PII (orders are pseudonymous from customer-side already). Email / name / etc. must NEVER appear in `props`.

## Implementation references

- Worker cookie module: `apps/edge/src/cookies.ts`
- Pixel consent module: `apps/pixel/src/runtime/consent.ts`
- Visitor id rotation: `apps/edge/src/visitor.ts`
- IP truncation: `apps/edge/src/enrich.ts`
- Project `tracking_domain` setting: stored in crobot `projects` table, published to KV, read by worker.

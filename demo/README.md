# testa demo

Run the pixel against a static HTML page on `localhost:7777`. Watch events
fly out of the page in real time.

## Setup

```sh
pnpm --filter @testa-platform/pixel build
node demo/server.mjs
```

Then open <http://localhost:7777/>.

## What you should see

The demo runs **one experiment** with three equally-weighted variations:

- **`variation_id = 200` (control)** — page renders unchanged.
- **`variation_id = 201` (CSS variation)** — headline goes red, CTA button
  scales up + relabels to "Buy Now — 30% Off".
- **`variation_id = 202` (redirect)** — `location.replace()` to `/promo.html`
  fires sub-second.

Each pageload re-buckets you. To force a specific variation, set the
assignment cookie in the console before reload:

```js
document.cookie = '_testa_exp_100=201; path=/'
```

## Things to look at

1. **The page itself** — the variation is visible after the first runtime
   tick (no flicker because there's no anti-flicker SDK config in this demo).

2. **`_testa.debug()`** — the panel at the bottom of the page auto-refreshes.
   Or call it yourself in the browser console:
   ```js
   _testa.debug()
   ```
   You'll see `consent_state`, `visitor_id`, `session_id`, the cycle log,
   redirect breadcrumbs, and network counters (queued / sent / dropped /
   retried / pending).

3. **The terminal** — every event hitting `POST /track` is logged with the
   event name, experiment ID, URL, and short visitor/session IDs. You'll
   typically see:
   - `experiment_view` immediately on hydrate
   - `cta_click` if you click the CTA button on the control or CSS variant
   - **For the redirect variant** the `experiment_view` arrives BEFORE the
     redirect (synchronous `sendBeacon`) — this is the SRM fix.

4. **DevTools → Network → filter "track"** — confirm the POST body and
   response. Note the `Set-Cookie: _testa_uuid=…` from the demo server.

## What this demo is NOT

- No collector. The events stop at the demo server's `console.log`. The
  real production pipeline goes pixel → edge worker → Durable Object →
  collector → Redis Stream → ClickHouse, and the bottom half of that
  pipeline is still skeleton.
- No edge worker. The demo server emulates `POST /track` (cookie + 204) but
  doesn't do enrichment, bot filtering, or DO routing. Run
  `pnpm --filter @testa-platform/edge dev` separately if you want that —
  the pixel just needs `apiUrl` pointed at the worker's URL.
- No real KV. Project config comes from `demo/dummy-config.json` baked
  inline into the HTML.

## Editing the experiment

Edit `demo/dummy-config.json` and reload. No restart needed (the config is
read on each HTML response).

Variation `changes[]` types you can use:
- `{ "type": "css", "selector": "...", "styles": { ... } }`
- `{ "type": "html", "selector": "...", "html": "..." }`
- `{ "type": "text", "selector": "...", "text": "..." }`
- `{ "type": "attribute", "selector": "...", "name": "...", "value": "..." }`
- `{ "type": "js", "code": "console.log('hello from variation')" }`
- `{ "type": "redirect", "from_url": "...", "to_url": "..." }`

# Known issues — production observations

A live log of issues observed in the field that the build needs to be aware of. Distinct from architectural decisions (those live in `docs/architecture/`) and from specific tasks (those live in `tasks/`).

Format: each entry has a date, the observation, the suspected cause, the impact, and what the build should do.

---

## 2026-05-05 — Cross-domain `_testa_cd` query parameter dropped on Next.js sites

**Observation.** Some users on customer sites built with Next.js (or similar SPA frameworks) experience tracking issues where their cross-domain experiment continuity breaks. Users see the right variation on the source domain but a fresh assignment on the destination, breaking unified attribution.

**Suspected cause.** Next.js (and other SPA routers) sometimes strip query parameters during client-side navigation, link rewriting, or rehydration. The 3.6 pixel encodes the cross-domain experiment+variation+uuid bridge as a `_testa_cd` query parameter on outbound links to whitelisted domains. If Next.js strips the param before the destination's pixel reads `window.location.search`, the bridge is broken.

**Impact.** Cross-domain experiments are silently corrupted on Next.js destination sites. Source-side attribution is fine; destination-side variation is re-rolled. Customer-visible AOV/RPV per variation becomes noisy.

**The 3.6 code is "airtight"** — the issue is not in our pixel; it's in how customer frameworks handle the URL between our two pixel firings. Hotfixes to 3.6 won't help.

**What 4.0 should do.**

- **Phase 3.7 cross-domain port (`runtime/experiments/apply/cross_domain.ts`)** must investigate this and is allowed to add a more robust transport. Candidates worth exploring:
  - **`postMessage`-based bridge via a transparent iframe pointing at the destination's pixel host.** Avoids URL entirely.
  - **Hash-based fragment** (`#_testa_cd=...`). Fragments are not stripped by SPA routers and not sent to servers. May survive client-side nav better.
  - **`localStorage` write on intent + `sessionStorage` cross-tab handoff.** Doesn't survive cross-domain by itself; combine with one of the above.
  - **Worker-bridged exchange** — source pixel POSTs intent to edge, destination pixel GETs by visitor_id. Round-trips an extra request but defeats URL stripping completely.
- **Defer the actual fix** until Phase 3.7 lands the 1:1 port and we can ship the improvement against a working baseline. v1 4.0 ships with the same `_testa_cd` query-param mechanism as 3.6 (preserving the bug for parity); the rework lands as a separate PR shortly after the pilot is stable.
- **Add a `[KNOWN-ISSUE-CD]` test** in `apps/pixel/e2e/3-6-parity.spec.ts` that explicitly asserts the current behavior. Then the post-pilot rework PR updates that test to assert the new behavior.

**Tracking.** Reopen this entry once the rework PR is open; close once the fix is in production for 2 weeks without regression.

---

## How to add an entry

When you observe a new production issue:

1. Append a new section above this footer with the date as `## YYYY-MM-DD — <one-line title>`.
2. Fill in observation / suspected cause / impact / what the build should do.
3. If it changes a task file's plan, update the task file too with a `## Notes from KNOWN_ISSUES` section linking back here.
4. Commit with `docs(known-issues): observe <one-line title>`.

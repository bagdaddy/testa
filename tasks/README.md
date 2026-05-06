# Tasks index

Each task = one focused PR. Agents pick the lowest-numbered `pending` task whose `blocked_by` is empty, work it through to a green PR, mark it `done`, and move on.

**Read order for any new task:**

1. The task file itself.
2. Linked architecture / reference docs.
3. `AGENTS.md` for repo-wide conventions.

**Status legend:** `pending` (open, ready to claim) · `in_progress` (claimed, work happening) · `blocked` (depends on a pending task) · `done` (PR merged) · `cancelled` (no longer needed).

---

## Phase 0 — Bootstrap (DONE inline; no task files)

Foundation work was done in the seed commits before this task system existed. See git history (commits `f93652b` → `e095a0d` → `af0feb2`).

## Phase 1 — Collector ingest + write path

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [1.1](./phase-1/1.1-clickhouse-schema-files.md) | ClickHouse schema files | done | — |
| [1.2](./phase-1/1.2-migration-runner.md) | CH migration runner CLI | pending | 1.1 |
| [1.3](./phase-1/1.3-clickhouse-singleton.md) | `@clickhouse/client` singleton | done | — |
| [1.4](./phase-1/1.4-ingest-route.md) | `POST /_ingest` route + HMAC + Zod | pending | 1.3 |
| [1.5](./phase-1/1.5-consumer-worker.md) | Consumer worker (XREADGROUP → CH INSERT) | pending | 1.1, 1.2, 1.3 |
| [1.6](./phase-1/1.6-fx-rates.md) | FX rates sync + dictionary endpoint | pending | 1.3 |
| [1.7](./phase-1/1.7-tests.md) | Vitest coverage for ingest, consumer, replay | pending | 1.4, 1.5 |

## Phase 2 — Edge worker

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [2.1](./phase-2/2.1-hono-router.md) | Hono router skeleton (routes wired) | done | — |
| [2.2](./phase-2/2.2-cookies.md) | First-party cookie module | pending | — |
| [2.3](./phase-2/2.3-enrich.md) | Geo + UA enrichment | pending | — |
| [2.4](./phase-2/2.4-bot-filter.md) | Bot heuristics (free signals) | pending | 2.3 |
| [2.5](./phase-2/2.5-batch-buffer-do.md) | DurableObject batch buffer | done | — |
| [2.6](./phase-2/2.6-ingest-forward.md) | HMAC sign + POST to collector | pending | 2.5 |
| [2.7](./phase-2/2.7-serve-pixel.md) | GET /projects/:slug.js — KV serve | pending | — |
| [2.8](./phase-2/2.8-tests.md) | miniflare + Vitest coverage | pending | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7 |
| [2.9](./phase-2/2.9-staging-deploy.md) | wrangler deploy to staging — **PAUSE** for human | pending | 2.8 |

## Phase 3 — Tracker pixel 4.0

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [3.1](./phase-3/3.1-loader-stub.md) | Loader stub + queue + monkey-patch installer | pending | — |
| [3.2](./phase-3/3.2-runtime-entry.md) | Runtime entry + queue hydration + `_testa.load()` | pending | 3.1 |
| [3.3](./phase-3/3.3-cookies-module.md) | Cookie module (5 cookies) | pending | — |
| [3.4](./phase-3/3.4-consent-state-machine.md) | Consent state machine + CMP integration | pending | — |
| [3.5](./phase-3/3.5-spa-navigation.md) | SPA navigation (patch consumer + canonical URL diff) | pending | 3.1 |
| [3.6](./phase-3/3.6-idb-outbox-transport.md) | IDB outbox + transport + retry + `_pixel_health` | pending | 3.4 |
| [3.7](./phase-3/3.7-audience-rule-engine.md) | Audience rule engine + sandboxed JS evaluator + legacy compat | pending | — |
| [3.8](./phase-3/3.8-traffic-assignment.md) | Variation traffic assignment (consistent-hash) | pending | 3.3 |
| [3.9](./phase-3/3.9-variation-apply.md) | Variation apply (CSS / HTML / text / attr / JS) | pending | 3.8 |
| [3.10](./phase-3/3.10-redirect-engine.md) | Redirect engine (decide + execute + loop guard + cross-domain + SPA) | pending | 3.7, 3.8 |
| [3.11](./phase-3/3.11-spa-redirect-harness.md) | SPA redirect repro harness (Next 12/13/14, RR6, plain JS) | pending | 3.10 |
| [3.12](./phase-3/3.12-legacy-globals-compat.md) | `window.Analytica.*` legacy globals + eventEmitter | pending | 3.2, 3.3, 3.8 |
| [3.13](./phase-3/3.13-legacy-http-calls.md) | Legacy HTTP calls (`/api/leads`, `/api/leads/convert`, `/api/pixel`) | pending | 3.12 |
| [3.14](./phase-3/3.14-bundle-build.md) | esbuild loader + runtime, content-hashed runtime URL | pending | 3.1, 3.2 |
| [3.15](./phase-3/3.15-test-coverage.md) | Vitest coverage + Playwright golden flows | pending | 3.1–3.13 |

The Phase 3 corpus reflects the 2026-05-06 grilling decisions: anti-flicker is the customer's SmartCode's job (no shielding in 3.x); redirect engine is state-of-the-art and pulled forward (no 1:1 port of 3.6 redirect bugs); audience targeting uses the new `AudienceCondition` schema (`docs/reference/audience-schema.md`); event delivery uses an IndexedDB outbox + UUIDv7 + deterministic Redis stream IDs for dedup; `window.Analytica.*` is a frozen API surface (`docs/reference/legacy-globals-inventory.md`).

## Phase 4 — Collector read API

To be scoped (after Phase 1.5 + Phase 3 partial).

## Phase 5 — Crobot integration

To be scoped (lives in `crobot` repo; tracked here for cross-repo coherence).

---

## Authoring future-phase tasks (meta-task)

If the routine runs out of pending unblocked tasks, the next-best work is **authoring the next phase's task files** itself, against the architecture + reference docs already in the repo. Conventions for that meta-task:

1. Pick the next un-scoped phase (3 → 4 → 5).
2. Use the existing task files (Phase 1, Phase 2) as templates — same frontmatter, same section headings.
3. Each task = one PR-sized chunk; cite specific files to create + reference docs.
4. Mark the task file `status: pending` (the human reviews on next PR).
5. Open a PR titled `docs(tasks): scope phase 3 — pixel 4.0 (1:1 port + new APIs)` with all the new task files in one commit.
6. Do NOT start implementing until those PRs are merged. The human gates the contract.

---

## Conventions for task files

Each task file has frontmatter:

```yaml
---
id: 1.4
title: ingest route
phase: 1
status: pending          # pending | in_progress | blocked | done | cancelled
estimate_days: 1
blocked_by: [1.3]
files_to_create:
  - apps/collector/src/ingest/route.ts
  - apps/collector/src/ingest/schema.ts
references:
  - docs/architecture/02-collector.md
  - docs/reference/hmac-protocol.md
  - docs/reference/event-shape.md
commits: []              # filled in when done
completed_at: null
---
```

Body sections (in order):

1. **Goal** — one paragraph, what this delivers.
2. **Context** — what already exists, what depends on this.
3. **Acceptance criteria** — bullet list of verifiable conditions.
4. **Implementation notes** — concrete guidance, code shape, traps.
5. **Tests** — what to write.
6. **Out of scope** — what NOT to build under this ID.

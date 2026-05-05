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
| [1.1](./phase-1/1.1-clickhouse-schema-files.md) | ClickHouse schema files | pending | — |
| [1.2](./phase-1/1.2-migration-runner.md) | CH migration runner CLI | pending | 1.1 |
| [1.3](./phase-1/1.3-clickhouse-singleton.md) | `@clickhouse/client` singleton | pending | — |
| [1.4](./phase-1/1.4-ingest-route.md) | `POST /_ingest` route + HMAC + Zod | pending | 1.3 |
| [1.5](./phase-1/1.5-consumer-worker.md) | Consumer worker (XREADGROUP → CH INSERT) | pending | 1.1, 1.2, 1.3 |
| [1.6](./phase-1/1.6-fx-rates.md) | FX rates sync + dictionary endpoint | pending | 1.3 |
| [1.7](./phase-1/1.7-tests.md) | Vitest coverage for ingest, consumer, replay | pending | 1.4, 1.5 |

## Phase 2 — Edge worker

To be scoped (task files added after Phase 1.4 lands so the HMAC contract is concrete).

## Phase 3 — Tracker pixel 4.0

To be scoped (task files added after Phase 1 + 2 are well underway).

## Phase 4 — Collector read API

To be scoped.

## Phase 5 — Crobot integration

To be scoped (lives in `crobot` repo; tracked here for cross-repo coherence).

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

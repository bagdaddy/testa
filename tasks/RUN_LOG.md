# Run log

Routine / agent session log. Most recent at top. Each entry: what was picked up, what shipped (draft PRs + branches), what's blocked, what's next on the queue.

---

## 2026-05-06 (Wed) — overnight, after grilling session

### Context

User initiated `/grill-me` to align on architecture for the next-gen pixel + edge + collector platform competing with VWO/ABTasty on tracking reliability, redirects, and targeting. Five questions answered; user went to sleep with instruction "implement what you can with the information I gave you and I will answer more questions tomorrow when I wake up". Auto mode was enabled for autonomous progress.

### Five architectural decisions reached (saved to project memory)

Pointers in `~/.claude/projects/-Users-mantasbagdonas-projects-testa-platform/memory/MEMORY.md`. Highlights:

1. **Anti-flicker is customer SmartCode's job, not the pixel's.** Pixel signals readiness via `_testa.load()`. `window.Analytica.*` legacy globals are a frozen API.
2. **Redirect engine is in v1 scope, state-of-the-art.** SPA + Next.js compatibility, query-param fidelity, loop guard, cross-domain visitor stitching. Microtask-ordered monkey-patch.
3. **Pixel is the primary integration; edge worker is a thin gateway.** ~99% of customers integrate via the JS pixel. Edge-decided redirects/targeting are a premium CNAME-edge side offering, not the default.
4. **New audience targeting JSON schema.** Nestable `all`/`any`/`not` over discriminated `AudienceLeaf` rules covering Tier 1 + Tier 2 dimensions. Sandboxed expression language for `visitor.custom`. New reference doc: `docs/reference/audience-schema.md`.
5. **Tracking reliability via IndexedDB outbox + deterministic Redis Stream IDs.** UUIDv7 event IDs, force-flush on pagehide, dedup at the queue (no CH schema disruption). Reserved synthetic event `_pixel_health` for drop-rate observability.

User key framing: "It's not really V1. V1 is what we have now. Now we're trying to ship the best thing we can." So no MVP-tier compromises.

### Picked up + shipped (draft branches, PRs need to be opened by hand)

The local dev box doesn't have `gh` CLI; agent pushed branches and reported the URLs. User needs to open PRs from those URLs in the morning.

| Task | Branch | PR URL | Status |
|---|---|---|---|
| 1.1 ClickHouse schema files | `feat/1.1-clickhouse-schema` | https://github.com/bagdaddy/testa/pull/new/feat/1.1-clickhouse-schema | ✅ pushed |
| docs(architecture): grilling decisions | `docs/architecture-grilling-decisions` | https://github.com/bagdaddy/testa/pull/new/docs/architecture-grilling-decisions | ✅ pushed |
| 1.3 `@clickhouse/client` singleton | `feat/1.3-clickhouse-singleton` | https://github.com/bagdaddy/testa/pull/new/feat/1.3-clickhouse-singleton | ✅ pushed |

### What each PR contains

**`feat/1.1-clickhouse-schema` (2 commits)**
- `chore: green baseline` — fixes pre-existing typecheck + lint failures from the seed scaffolding (apps/edge tsconfig rootDir, apps/pixel tsconfig rootDir, apps/edge useless constructor, playwright workers field with `exactOptionalPropertyTypes`, `allowImportingTsExtensions` in base, biome auto-format pass on turbo.json + esbuild.config.mjs, generated pnpm-lock.yaml).
- `feat(collector): 1.1 ClickHouse schema files` — 9 numbered SQL migrations under `apps/collector/db/migrations/`. Smoke-tested live against CH 24.10. **Bug caught + fixed during smoke test:** the 5 materialized views need `SETTINGS allow_nullable_key = 1` because their `ORDER BY` includes the nullable `experiment_id` and `variation_id`. Reference doc updated to match (deviation noted in operational-notes block).

**`docs/architecture-grilling-decisions` (1 commit)**
- Updates `01-tracker.md`, `02-collector.md`, `03-data-model.md`, `05-rollout.md`, `event-shape.md`, `project-config-shape.md`. New `audience-schema.md`. Captures all 5 grilling decisions in the repo so the next routine cycle (and the human) sees them as the source of truth, not just in agent memory. Pre-existing typecheck/lint failures inherit from main; this PR doesn't introduce any. Will rebase clean once feat/1.1's chore commit lands.

**`feat/1.3-clickhouse-singleton` (2 commits)**
- Cherry-picks the chore baseline commit (so typecheck/lint pass standalone — when feat/1.1 lands on main, the cherry-picked commit becomes a no-op).
- `feat(collector): 1.3 ClickHouse client singleton` — `apps/collector/src/db/clickhouse.ts` with lazy init, `insertEvents`, `query`, `command`, `ping`, `close`, `__setClientForTests`. Test in `src/db/__tests__/clickhouse.test.ts` using `bun:test`, `it.skipIf` when no CH endpoint.

### Verification status per PR

- `pnpm -r typecheck`: ✅ clean on feat/1.1 + feat/1.3 (✗ on docs branch — inherits from main, fixes coming once chore lands).
- `pnpm lint`: ✅ clean on feat/1.1 + feat/1.3 (✗ on docs branch — same reason).
- `pnpm --filter @testa-platform/pixel test`, `apps/edge test`: ✅ pass.
- `pnpm --filter @testa-platform/collector test`: ⚠️ NOT RUN — `bun` missing on dev machine. Per AGENTS.md "Surface the missing tool to the human; do NOT silently skip." Need bun installed locally OR rely on CI to run collector tests.

### Blocked / open questions for next session

The user said they'd answer more grilling questions in the morning. The next questions in queue (ranked):

1. **Schema fields gaps for the events table.** `viewport_w` / `viewport_h`, `screen_w` / `screen_h`, `client_ts` vs `server_ts`, `tracker_version`, raw IP forwarding policy beyond the current "drop at edge" — none of these are in the wide events row today and most paid tools have at least viewport + tracker_version. Worth a question.
2. **Idempotency / deterministic Redis stream ID specifics.** I sketched a `<event_id_hash>-<seq>` scheme in the docs but Redis Streams require strictly monotonic IDs across the stream — the actual implementation has subtle edge cases. Need to confirm before 1.4.
3. **Hash function for consistent variation bucketing.** Currently `hash(visitor_id + experiment_id) mod 100`. What hash? murmur3? FNV-1a? Affects backwards compat with 3.6's existing buckets — visitors mid-experiment must keep the same variation if we cut over.
4. **Frequency capping / mutual exclusion across experiments.** Tier 2 audience dimension; mentioned in audience schema but the cookie-based persistence + interaction with `traffic_allocation` needs a design pass.
5. **Multi-tenancy / per-project rate limits + quotas.** For the collector and edge, how to defend against one customer's traffic spike DOS'ing others.
6. **`window.Analytica.*` exact inventory.** Current docs say "frozen API" but we need a complete enumeration from 3.6's script.js — names, types, when they're set. Could be a meta-task while we wait for grilling.
7. **Code-style preferences not yet captured:** error handling style (Result<T,E> vs throw?), logging stack (pino? OTel?), DI pattern (factory functions / constructor params / context object), how strict on immutability when wrapping mutable browser APIs (DOM mutation, history).
8. **Phase 3 (pixel) task corpus.** With the new posture (anti-flicker → SmartCode, redirect engine in scope, audience eval, IDB outbox, etc.), Phase 3 task files don't exist yet. Per AGENTS.md "Authoring future-phase tasks" the routine should write them next once the docs PR is merged.

### Tonight's queue items NOT done

- **1.6 FX rates sync + dictionary endpoint** — was on the queue but skipped: blocked-by 1.3 in spec; though I could pre-stage code, the FX module needs a Frankfurter API client + JSONEachRow internal endpoint + cron scheduling, which is non-trivial and benefits from explicit grilling on the cron host (cf-cron? bun setInterval? Sidecar?). Left for next session.
- **2.1 Hono router skeleton** — was on the queue but skipped: would have been productive but context budget was getting thin and I prioritized capturing the architectural decisions in the repo over more code that the user might want to redirect after morning grilling.
- **No PR creation via `gh`** — `gh` CLI not on PATH. User opens PRs from the GitHub URLs above.
- **No collector test execution** — `bun` not on PATH. Tests will run in CI.

### Recommended next steps for the user (in the morning)

1. Open the 3 draft PRs from the URLs above. Review the docs PR (most opinionated content); the 1.1 and 1.3 PRs are routine.
2. Decide stack order: feat/1.1 first (carries the chore baseline), then docs/architecture-grilling-decisions, then feat/1.3. Or merge feat/1.1, rebase the others.
3. Install `bun` locally if you want the collector test runner to work outside CI. (Or accept that CI is the only place collector tests run.)
4. Continue grilling — open questions in the list above. The biggest leverage ones are #1 (schema gaps), #6 (window.Analytica inventory), #7 (code-style preferences) since they unblock multiple future tasks.

### Routine instruction for resumed sessions

When resuming: read this file, read `~/.claude/projects/-Users-mantasbagdonas-projects-testa-platform/memory/MEMORY.md`, read the modified architecture docs in this branch, then pick up from "open questions" or the lowest-numbered pending unblocked task per `tasks/README.md`.

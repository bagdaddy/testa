# AGENTS.md — How AI agents work in this repo

This repo is built **incrementally by AI agents** (primarily Claude Code) running structured task files. A human reviews each PR. This file is the contract between repo and agent.

## Read this first, every session

1. **`README.md`** — what the repo is
2. **`docs/architecture/00-overview.md`** — the system at a glance
3. **`tasks/README.md`** — index of all task files, with status (pending / in_progress / done)
4. **The task file you're about to execute** — full context, success criteria, files to touch

If you can't find a task file matching what you're about to do, **stop**. Either the work isn't planned yet, or you're improvising. Surface it to the human via a roadmap update or a new task file proposal.

## Repo conventions

- **Single language: TypeScript.** Every app is TS. No JS in `src/`.
- **Strict TS.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. If you need to weaken a constraint, justify it in the PR.
- **Imports.** Use `import type` for types. Use explicit `.ts` extensions in relative imports (we use `verbatimModuleSyntax`).
- **Linter/formatter.** Biome. Run `pnpm lint:fix && pnpm format` before each commit.
- **Tests.** Vitest for `apps/pixel` and `apps/edge`. `bun test` for `apps/collector`. Every public function needs a test. 80%+ coverage target on `apps/pixel`.
- **Commits.** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`). Reference the task file in the body when applicable.
- **PR size.** One task = one PR. Keep diffs reviewable (~300 LOC max). If a task grows, split it.

## What to commit, what NOT to commit

**Commit:**
- Source code, tests, configs, docs
- `pnpm-lock.yaml` (after `pnpm install`)
- `package.json` changes
- Type definitions in `packages/shared-types/`

**Never commit:**
- `.env` (use `.env.example` for docs)
- `node_modules`, `dist`, `.turbo`, `.wrangler`
- Production secrets, KV namespace IDs, Worker zone IDs
- Customer data of any kind

## Running locally

```sh
# One-time
pnpm install
docker compose up -d                       # redis + clickhouse

# Each app
pnpm --filter @testa-platform/pixel dev
pnpm --filter @testa-platform/edge dev
pnpm --filter @testa-platform/collector dev:server
pnpm --filter @testa-platform/collector dev:consumer

# Verification
pnpm -r typecheck && pnpm -r test && pnpm lint
```

## Tools the agent expects

- `pnpm` ≥ 10
- `node` ≥ 22
- `bun` (latest) — required for `apps/collector`
- `docker` + `docker compose`
- `wrangler` (via pnpm) for the edge worker

If `bun` isn't installed locally, `pnpm --filter @testa-platform/collector` commands will fail. Surface the missing tool to the human; do NOT silently skip.

## Autonomy guardrails

**Never do without explicit human approval:**

1. **`git push --force` or `--force-with-lease`** on any branch.
2. **Push to a branch that has an open PR** without coordinating.
3. **Create a Cloudflare KV namespace** in the production CF account (placeholder IDs in `wrangler.toml` are fine; real ones come from a human run of `wrangler kv namespace create`).
4. **Deploy the worker** (`wrangler deploy`). Local `wrangler dev` is fine.
5. **Run any database/ClickHouse statement against a non-local instance.**
6. **Modify the HMAC secret rotation behavior** without a security review.
7. **Disable CI checks**, skip pre-commit hooks (`--no-verify`), or weaken Biome rules.
8. **Change the public API shape of `packages/shared-types`** without bumping a version note in the PR description.

**OK to do unattended:**

- All work in feature branches.
- Local `pnpm install`, `bun test`, `wrangler dev`, `docker compose up -d`.
- Refactors that don't change observable behavior, with tests proving parity.
- Bumping pinned dep versions in `package.json` if `pnpm install` succeeds and tests pass.
- Adding tests, fixtures, docs.

## When you finish a task

1. Run `pnpm -r typecheck && pnpm -r test && pnpm lint`. All must pass.
2. Update the task file's frontmatter: `status: done`, `completed_at: <date>`, `commits: [<short-sha>...]`.
3. Update `tasks/README.md` index.
4. If the work changes architecture, update the relevant `docs/architecture/*.md`.
5. Commit the docs updates *with* the code change (same commit), not separately.
6. Open a PR titled with the task ID: `feat(collector): 1.4 ingest route with HMAC + Zod`.

## Cross-repo coordination

This repo is one half of the analytics overhaul. The other half lives in **crobot**:

- **Strategic plan (decisions):** `~/.claude/plans/mossy-honking-hare.md`
- **Living roadmap (state):** `crobot/docs/ANALYTICS_OVERHAUL_ROADMAP.md`
- **Memory pointer:** `~/.claude/projects/-Users-mantasbagdonas-projects-crobot/memory/analytics_overhaul.md`

If you make a decision in one repo that the other needs to know about, update the corresponding doc in both. The plan file is read-only after approval; the roadmap absorbs new decisions.

## When in doubt

Ask the human via the roadmap's "Open questions" section, or stop and surface the question. Do not guess on architecture.

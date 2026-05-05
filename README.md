# testa-platform

Frontend tracker + edge worker + event collector for Testa's experimentation platform.

This repo houses the **client-side tracker** (TS pixel + Cloudflare Worker) and the **server-side collector** (Bun + Hono + ClickHouse). The crobot Laravel app remains the source of truth for experiment, project, and goal entities; this repo owns event ingest, the warehouse, and the SDK that runs on customers' sites.

## Layout

```
apps/
├── pixel/         # TS — loader.ts (sync stub) + runtime/* (experiment engine + tracking)
├── edge/          # TS — Cloudflare Worker (serves pixel, /track, first-party cookies)
└── collector/     # Bun + Hono — /_ingest (write) + /api/v1/metrics/* (read) + CH consumer

packages/
└── shared-types/  # TS — Event, Metric, ProjectConfig, ConsentState
```

## Architecture & roadmap

- **Strategic plan:** [`~/.claude/plans/mossy-honking-hare.md`](https://localhost) (decisions, diagrams, phases)
- **Living roadmap:** [`crobot/docs/ANALYTICS_OVERHAUL_ROADMAP.md`](https://localhost) (current state, next actions, done log)
- **Memory:** [`~/.claude/projects/.../memory/analytics_overhaul.md`](https://localhost) (constraints + boundaries)

## Stack

- TypeScript everywhere
- pnpm workspaces + Turborepo
- Pixel: esbuild
- Edge: Cloudflare Workers (`wrangler`)
- Collector: Bun + Hono + `@clickhouse/client` + `ioredis` + `zod`
- Storage: ClickHouse 24.x (single node, MergeTree + Buffer + materialized views, 13-month TTL)
- Queue: Redis Stream `events`
- Linter/formatter: Biome
- Tests: Vitest (unit) + Playwright (E2E for pixel)

## Local dev

```sh
# One-time
pnpm install

# Start backing services
docker compose up -d                     # redis + clickhouse

# Run the apps
pnpm --filter collector dev:server       # Bun HTTP server
pnpm --filter collector dev:consumer     # Bun consumer worker
pnpm --filter edge dev                   # wrangler dev
pnpm --filter pixel dev                  # esbuild watch + fixture page

# Test
pnpm -r test                             # unit tests across all apps
pnpm --filter pixel test:e2e             # Playwright
```

## Status

**Phase 0 — bootstrap.** Workspace scaffolding in progress. See the roadmap for current state.

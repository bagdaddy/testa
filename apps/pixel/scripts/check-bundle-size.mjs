#!/usr/bin/env node
/**
 * Bundle size-cap CI guard.
 *
 * Builds the pixel and asserts that loader + runtime bundles stay under the
 * configured caps (gzipped). Run via `pnpm --filter @testa-platform/pixel
 * check:size` in CI; fails non-zero if any cap is exceeded.
 *
 * Caps reflect the contractual size budget for the customer-facing pixel:
 *   - loader: 5 KB gzip — must inline cleanly into customer SmartCode
 *   - runtime: 40 KB gzip — competitive with VWO (~45 KB) / ABTasty (~38 KB)
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');

const TARGETS = [
  { name: 'loader', file: 'loader.min.js', maxGzipBytes: 5 * 1024 },
  { name: 'runtime', file: 'runtime.min.js', maxGzipBytes: 40 * 1024 },
];

function check(target) {
  const path = resolve(distDir, target.file);
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    console.error(`[size-cap] missing bundle ${path} — run \`pnpm build\` first`);
    return { ok: false };
  }
  const rawSize = statSync(path).size;
  const gzipSize = gzipSync(raw).length;
  const cap = target.maxGzipBytes;
  const pct = ((gzipSize / cap) * 100).toFixed(1);
  const ok = gzipSize <= cap;

  const status = ok ? 'OK' : 'FAIL';
  console.log(
    `[size-cap] ${status}  ${target.name.padEnd(8)}  raw=${formatKb(rawSize)}  gzip=${formatKb(gzipSize)}  cap=${formatKb(cap)}  used=${pct}%`,
  );
  return { ok, target, gzipSize };
}

function formatKb(bytes) {
  const kb = bytes / 1024;
  return `${kb.toFixed(2)} KB`;
}

const results = TARGETS.map(check);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`[size-cap] ${failed.length} bundle(s) over budget`);
  process.exit(1);
}
console.log('[size-cap] all bundles within budget');

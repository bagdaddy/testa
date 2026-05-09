#!/usr/bin/env node
/**
 * Demo static server — emulates what the edge worker does in production:
 *   - Serves the customer's HTML pages.
 *   - Inlines `window.cfPrefill = {...}` so the pixel finds its config.
 *   - Serves the pixel bundles from apps/pixel/dist/.
 *   - Accepts POST /track and logs every event to the terminal in real time.
 *
 * Run: `node demo/server.mjs` (after `pnpm --filter @testa-platform/pixel build`).
 *
 * No build step. No deps. Pure Node http.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 7777);

const DEMO_CONFIG = JSON.parse(await readFile(resolve(__dirname, 'dummy-config.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { pathname } = url;

  // ─── /track — what the pixel posts to ──────────────────────────────────
  if (req.method === 'POST' && pathname === '/track') {
    return handleTrack(req, res);
  }
  if (req.method === 'OPTIONS' && pathname === '/track') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  // ─── pixel bundle assets ──────────────────────────────────────────────
  if (pathname.startsWith('/dist/')) {
    return serveStatic(res, resolve(repoRoot, 'apps/pixel', pathname.slice(1)));
  }

  // ─── HTML pages — inject cfPrefill ────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveHtmlWithConfig(res, resolve(__dirname, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/promo.html') {
    return serveHtmlWithConfig(res, resolve(__dirname, 'promo.html'));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╭─────────────────────────────────────────────────────╮');
  console.log('│  testa demo running                                 │');
  console.log(`│  http://localhost:${PORT}/                              │`);
  console.log('│                                                     │');
  console.log(`│  Project: ${DEMO_CONFIG.slug.padEnd(42)}│`);
  console.log(`│  Experiments: ${String(DEMO_CONFIG.experiments.length).padEnd(38)}│`);
  console.log('│                                                     │');
  console.log('│  Reload to re-bucket. Open DevTools → Network        │');
  console.log('│  → filter "track" to watch events fly out.          │');
  console.log('╰─────────────────────────────────────────────────────╯');
  console.log('');
});

// ─── handlers ──────────────────────────────────────────────────────────

async function serveStatic(res, filepath) {
  try {
    const buf = await readFile(filepath);
    const type = MIME[extname(filepath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`missing: ${filepath}\n(did you run \`pnpm --filter @testa-platform/pixel build\`?)\n`);
  }
}

async function serveHtmlWithConfig(res, htmlPath) {
  try {
    let html = await readFile(htmlPath, 'utf8');
    const cfPrefill = {
      project: DEMO_CONFIG,
      apiUrl: `http://localhost:${PORT}`,
    };
    const inject = `<script>window.__DEMO_CFPREFILL__ = ${JSON.stringify(cfPrefill)};</script>\n`;
    const marker = '<script>\n      window.cfPrefill = window.__DEMO_CFPREFILL__;';
    html = html.replace(marker, `${inject}    ${marker}`);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`server error: ${err.message}\n`);
  }
}

async function handleTrack(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  let events = [];
  try {
    events = JSON.parse(body);
  } catch {
    events = [];
  }

  const ts = new Date().toISOString().slice(11, 23);
  for (const ev of events) {
    const tag = `\x1b[36m${ev.event_name ?? '?'}\x1b[0m`;
    const exp = ev.experiment_id ? ` exp=${ev.experiment_id}/v=${ev.variation_id ?? '?'}` : '';
    const url = ev.url ? ` url=${shortUrl(ev.url)}` : '';
    console.log(
      `[${ts}] → ${tag}${exp}${url} visitor=${shortId(ev.visitor_id)} session=${shortId(ev.session_id)}`,
    );
  }

  // Mint or refresh visitor cookie like the real edge does.
  const cookieHeader = req.headers.cookie ?? '';
  const existing = /(?:^|;\s*)_testa_uuid=([^;]+)/.exec(cookieHeader)?.[1];
  const visitor = existing && /^[0-9a-f-]{36}$/i.test(existing) ? existing : randomUUID();
  const setCookie = `_testa_uuid=${visitor}; Max-Age=63072000; Path=/; SameSite=Lax`;

  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'set-cookie': setCookie,
    'cache-control': 'no-store',
  });
  res.end();
}

function shortId(id) {
  if (!id || typeof id !== 'string') return '-';
  return id.slice(0, 8);
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.pathname + url.search;
  } catch {
    return u;
  }
}

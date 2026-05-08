/**
 * Tracker pixel runtime entry point.
 *
 * Loaded as `<script defer src="/projects/:slug.js?bundle=runtime">` after the
 * inline loader stub installs `window._testa`. Hydration drains the queue,
 * wires legacy globals, sets up CMP + SPA listeners, runs the first
 * experiment cycle, and starts the network transport.
 */

import { hydrate } from './lifecycle.ts';

hydrate();

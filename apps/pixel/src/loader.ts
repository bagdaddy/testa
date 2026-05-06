/**
 * Synchronous loader stub injected inline at the top of the served pixel.
 *
 * Two responsibilities:
 *   1. Set up `window._testa` queue (`./loader/queue.ts`)
 *   2. Install the history monkey-patch (`./loader/monkey-patch.ts`)
 *
 * Stays under 5 KB minified. No external dependencies. Sync — runs before any
 * customer code that depends on `window._testa` being present.
 *
 * The runtime bundle (`./runtime/index.ts`) loads after this with `<script defer>`
 * and hydrates the queue + replaces method bodies with live implementations.
 */

import { installMonkeyPatch } from './loader/monkey-patch.ts';
import { installQueue } from './loader/queue.ts';

installQueue();
installMonkeyPatch();

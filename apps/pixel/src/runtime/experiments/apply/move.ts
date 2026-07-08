/**
 * Move variation (legacy 3.3.3 `move_element_append` / `move_element_prepend`):
 * relocate each matching element under a single `target` node.
 *
 *  - position 'append'  → `target.appendChild(el)` (moves el to end of target)
 *  - position 'prepend' → `target.prepend(el)`     (moves el to start of target)
 *
 * `appendChild`/`prepend` MOVE the node (they detach it from its current
 * parent), matching the legacy behaviour. We resolve `target` per element via a
 * single, safe `querySelector`; if the target is missing the move is a no-op
 * for that element (mirrors legacy's `if (parent) { ... }` guard).
 *
 * Watches the DOM through `eachMatching` (current + late-rendered matches) and
 * returns a teardown; the WeakSet dedupe means each element is moved once.
 */

import { eachMatching } from './dom.ts';

export interface MoveChange {
  type: 'move';
  selector: string;
  target: string;
  position: 'append' | 'prepend';
}

export function applyMove(change: MoveChange): () => void {
  return eachMatching(change.selector, (el) => {
    const target = safeQuerySelector(change.target);
    if (!target) return; // Target not on the page (yet) — skip, like legacy.
    if (change.position === 'append') {
      target.appendChild(el);
    } else {
      target.prepend(el);
    }
  });
}

/** Single-match lookup that swallows malformed selectors, like dom.ts helpers. */
function safeQuerySelector(selector: string): Element | null {
  if (typeof document === 'undefined') return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

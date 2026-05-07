/**
 * Attribute variation: setAttribute(name, value) on each match.
 *
 * Use cases: changing `href`, `aria-label`, `data-testid`, etc.
 * Refuses to set anything starting with `on` (event handlers — that's the
 * `js` change type's job, and explicit defense against an admin pasting
 * `onclick="..."`).
 */

import { eachMatching } from './dom.ts';

export interface AttributeChange {
  type: 'attribute';
  selector: string;
  name: string;
  value: string;
}

export function applyAttribute(change: AttributeChange): () => void {
  if (isUnsafeAttribute(change.name)) return () => {};
  return eachMatching(change.selector, (el) => {
    el.setAttribute(change.name, change.value);
  });
}

function isUnsafeAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return true; // onclick, onmouseover, …
  if (lower === 'srcdoc') return true; // can host arbitrary HTML
  return false;
}

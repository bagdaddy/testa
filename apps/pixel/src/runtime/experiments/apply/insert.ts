/**
 * Insert variations (legacy 3.3.3 `append_html` / `prepend_html`): inject
 * customer HTML relative to each matching element via `insertAdjacentHTML`.
 *
 *  - append  → `insertAdjacentHTML('beforeend', html)`  (inside, at the end)
 *  - prepend → `insertAdjacentHTML('afterbegin', html)` (inside, at the start)
 *
 * Like `applyHtml`, these watch the DOM through `eachMatching` (current +
 * late-rendered matches) and return a teardown. The WeakSet in `eachMatching`
 * dedupes, so each element is inserted into exactly once even as the observer
 * fires for late arrivals.
 *
 * We strip `<script>` tags with the same `stripScriptTags` defense-in-depth as
 * `applyHtml` — a script inside injected HTML doesn't execute anyway, but we
 * strip it so behaviour is predictable. Customers who need JS use the `js`
 * change type.
 */

import { eachMatching } from './dom.ts';
import { stripScriptTags } from './html.ts';

export interface AppendChange {
  type: 'append';
  selector: string;
  html: string;
}

export interface PrependChange {
  type: 'prepend';
  selector: string;
  html: string;
}

export function applyAppend(change: AppendChange): () => void {
  const sanitized = stripScriptTags(change.html);
  return eachMatching(change.selector, (el) => {
    el.insertAdjacentHTML('beforeend', sanitized);
  });
}

export function applyPrepend(change: PrependChange): () => void {
  const sanitized = stripScriptTags(change.html);
  return eachMatching(change.selector, (el) => {
    el.insertAdjacentHTML('afterbegin', sanitized);
  });
}

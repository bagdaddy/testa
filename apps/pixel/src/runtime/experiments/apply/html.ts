/**
 * HTML variation: replace `el.innerHTML` with the customer-supplied HTML.
 *
 * Customers using this know they're injecting HTML — that's the contract.
 * We do strip `<script>` tags as a defense-in-depth measure: a script tag
 * inside innerHTML doesn't execute (browsers ignore it for security), but
 * we strip it anyway so customers don't get confused why their JS isn't
 * running and so a future change to that browser behavior doesn't surprise
 * us. Customers who need JS use the `js` change type.
 *
 * `<iframe>`, `<object>`, `<embed>` are NOT stripped — customers legitimately
 * embed YouTube and similar.
 */

import { eachMatching } from './dom.ts';

export interface HtmlChange {
  type: 'html';
  selector: string;
  html: string;
}

export function applyHtml(change: HtmlChange): () => void {
  const sanitized = stripScriptTags(change.html);
  return eachMatching(change.selector, (el) => {
    el.innerHTML = sanitized;
  });
}

/**
 * Strip `<script>...</script>` (any case, any attributes) from the HTML.
 * A regex is sufficient — it's a defense-in-depth measure on top of the
 * browser's own innerHTML behavior, not the only line of defense.
 */
export function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

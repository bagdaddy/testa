/**
 * Text variation: replace `el.textContent` for each match (current + future).
 *
 * Use textContent (not innerHTML) so HTML in the customer-supplied string is
 * treated as text and not parsed. Customers wanting actual HTML use the
 * `html` change type.
 */

import { eachMatching } from './dom.ts';

export interface TextChange {
  type: 'text';
  selector: string;
  text: string;
}

export function applyText(change: TextChange): () => void {
  return eachMatching(change.selector, (el) => {
    el.textContent = change.text;
  });
}

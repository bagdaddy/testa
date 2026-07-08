/**
 * Hide variation (legacy 3.3.3 `hide_element`): set `display:none` on each
 * matching element.
 *
 * Watches the DOM via `eachMatching`, so elements that render AFTER apply (SPA
 * / late React render) are also hidden — the modern equivalent of 3.3.3's
 * `setTimeout` retry loop (`handleCopyFields`), and consistent with how
 * html/text/attribute keep late matches in sync. Returns a teardown that
 * disconnects the observer; the lifecycle disposes it on the next cycle.
 */

import { eachMatching } from './dom.ts';

export interface HideChange {
  type: 'hide';
  selector: string;
}

export function applyHide(change: HideChange): () => void {
  return eachMatching(change.selector, (el) => {
    if (el instanceof HTMLElement) {
      el.style.display = 'none';
    }
  });
}

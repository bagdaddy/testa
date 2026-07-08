/**
 * Variation apply — composition root that walks `change[]` and dispatches to
 * the per-type appliers (css/html/text/attribute/js).
 *
 * Returns a list of teardown functions for the appliers that watch the DOM
 * (text, attribute, html). The caller (lifecycle's experiment cycle) collects
 * these and disconnects the observers when the next cycle starts, so a SPA
 * route change doesn't leave stale watchers piling up.
 *
 * `redirect` change type is NOT handled here. The redirect engine (Phase 3.10)
 * is a separate concern that runs BEFORE variation apply.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { type AttributeChange, applyAttribute } from './attribute.ts';
import { type CssChange, applyCss } from './css.ts';
import { type HideChange, applyHide } from './hide.ts';
import { type HtmlChange, applyHtml } from './html.ts';
import { type AppendChange, type PrependChange, applyAppend, applyPrepend } from './insert.ts';
import { type JsChange, applyJs } from './js.ts';
import { type MoveChange, applyMove } from './move.ts';
import { type TextChange, applyText } from './text.ts';

export type Teardown = () => void;

/**
 * Apply every change for a variation. Returns teardowns for the DOM-watching
 * appliers; the caller disposes them on the next experiment cycle.
 */
export function applyVariation(
  variationId: number | string,
  changes: VariationChange[],
): Teardown[] {
  const teardowns: Teardown[] = [];
  for (const change of changes) {
    try {
      const teardown = applyOne(variationId, change);
      if (teardown) teardowns.push(teardown);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[testa] applier threw:', err);
    }
  }
  return teardowns;
}

function applyOne(variationId: number | string, change: VariationChange): Teardown | null {
  switch (change.type) {
    case 'css':
      applyCss(variationId, change as CssChange);
      // CSS doesn't watch the DOM (uses a global <style> tag). No teardown.
      return null;

    case 'text':
      return applyText(change as TextChange);

    case 'attribute':
      return applyAttribute(change as AttributeChange);

    case 'html':
      return applyHtml(change as HtmlChange);

    case 'js':
      applyJs(change as JsChange);
      return null;

    case 'hide':
      // Watches the DOM (late-render parity with 3.3.3's retry loop); returns
      // a teardown the caller disposes on the next cycle.
      return applyHide(change as HideChange);

    case 'append':
      return applyAppend(change as AppendChange);

    case 'prepend':
      return applyPrepend(change as PrependChange);

    case 'move':
      return applyMove(change as MoveChange);

    case 'redirect':
      // Phase 3.10 owns redirect application. Variation apply ignores it.
      return null;
  }
}

export {
  applyAppend,
  applyAttribute,
  applyCss,
  applyHide,
  applyHtml,
  applyJs,
  applyMove,
  applyPrepend,
  applyText,
};

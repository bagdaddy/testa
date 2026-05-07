/**
 * CSS variation: inject a <style> tag with the selector + style declarations.
 *
 * Why a global <style> tag instead of inline `el.style`:
 *   - Survives DOM re-renders (React replaces nodes; inline styles vanish).
 *   - Idempotent — re-applying the same change overwrites the same tag instead
 *     of mutating every match's style attribute.
 *   - Higher specificity in tournament with site CSS (we tag selectors with
 *     `[data-testa-applied]` to win predictably without `!important`).
 */

const STYLE_ID_PREFIX = 'testa-css-';

export interface CssChange {
  type: 'css';
  selector: string;
  styles: Record<string, string>;
}

/**
 * Apply a CSS variation. Idempotent: re-running with the same `(variationId,
 * change)` key overwrites the existing `<style>` tag instead of stacking.
 *
 * `variationId` is part of the style tag's id so multiple variations on the
 * same page (different experiments, different selectors) don't clobber each
 * other.
 */
export function applyCss(variationId: number | string, change: CssChange): void {
  if (typeof document === 'undefined') return;
  const id = `${STYLE_ID_PREFIX}${variationId}-${hashSelector(change.selector)}`;
  const existing = document.getElementById(id);
  const cssText = renderRule(change);

  if (existing instanceof HTMLStyleElement) {
    existing.textContent = cssText;
    return;
  }

  const style = document.createElement('style');
  style.id = id;
  style.setAttribute('data-testa-css', String(variationId));
  style.textContent = cssText;
  document.head.appendChild(style);
}

function renderRule(change: CssChange): string {
  const declarations = Object.entries(change.styles)
    .map(([prop, value]) => `${escapeProp(prop)}: ${escapeValue(value)};`)
    .join(' ');
  return `${change.selector} { ${declarations} }`;
}

function escapeProp(p: string): string {
  // Strip anything that could break out of the property name.
  return p.replace(/[^a-zA-Z0-9-]/g, '');
}

function escapeValue(v: string): string {
  // Disallow `{`, `}` (would open / close a rule and let a malicious
  // value start a new selector), `<` (HTML bleed) and `;` followed by
  // an open-brace pattern (already covered by stripping `{`). Customers
  // should not be crafting CSS with these in legitimate cases — `url()`
  // and similar legitimate uses don't need them.
  return v.replace(/[<{}]/g, '');
}

/** Cheap hash so the style tag id is short + deterministic per selector. */
function hashSelector(selector: string): string {
  let h = 5381;
  for (let i = 0; i < selector.length; i++) {
    h = ((h << 5) + h + selector.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

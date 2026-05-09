/**
 * JS injection variation: customer-supplied JS evaluated in the page context.
 *
 * Yes, this is `new Function(code)()`. It's intentional — customers paste
 * their own JS into the admin form (with the same trust posture they'd
 * have inline in their own site). We isolate evaluation so a throw doesn't
 * crash the runtime, and the rest of the runtime keeps going.
 *
 * Out of scope: this is NOT the sandboxed expression evaluator for
 * `visitor.custom` audience leaves (Phase 3.7b). That one walks an AST
 * with a fixed context and never sees raw JS strings. This one runs the
 * customer's own code with full page access — by design.
 */

export interface JsChange {
  type: 'js';
  code: string;
}

export function applyJs(change: JsChange): void {
  if (typeof window === 'undefined') return;
  if (!change.code) return;
  try {
    // `new Function(code)()` is intentional — variation JS is the customer
    // contract. We rely on Function constructor (not eval) to keep the global
    // scope clean while still letting customers script DOM mutations.
    new Function(change.code)();
  } catch (err) {
    // Don't crash the page on a customer JS bug. Log + carry on.
    // eslint-disable-next-line no-console
    console.error('[testa] variation JS threw:', err);
  }
}

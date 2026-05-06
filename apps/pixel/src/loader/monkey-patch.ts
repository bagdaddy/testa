/**
 * History API monkey-patch — earliest possible installation point so we
 * catch every SPA navigation, including the ones a framework's router does
 * during its own hydration phase.
 *
 * Patch design (from `docs/architecture/01-tracker.md` § SPA navigation):
 *
 *   1. Idempotent — guarded by `window._testa_patched_v4` so a double-loaded
 *      pixel doesn't re-wrap the wrapper.
 *   2. Calls the original FIRST (so the framework's state advances normally).
 *   3. Queues a microtask AFTER the original returns; the microtask dispatches
 *      `_testa:locationchange` CustomEvent. This ordering means downstream
 *      handlers see the framework's updated router state, fixing the Next.js
 *      query-param race the user reported.
 *   4. `popstate` and `hashchange` listeners feed into the same dispatch.
 *   5. `pageshow` re-installs the patch if bfcache restored the original
 *      references (Safari sometimes hands them back live).
 *
 * Out of scope here: the listener side (debounce, canonical-URL diff, re-eval).
 * That lives in `runtime/spa.ts` (Phase 3.5). This file just emits the event.
 */

const PATCH_FLAG = '_testa_patched_v4' as const;
const LOCATIONCHANGE_EVENT = '_testa:locationchange' as const;

type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;

interface PatchedWindow extends Window {
  [PATCH_FLAG]?: boolean;
}

export function installMonkeyPatch(): void {
  const w = window as PatchedWindow;
  if (w[PATCH_FLAG]) return;

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  window.addEventListener('popstate', dispatchLocationChange);
  window.addEventListener('hashchange', dispatchLocationChange);

  // bfcache restore can hand back the original `history.pushState` reference,
  // unwrapping our patch. Re-check on every pageshow.
  window.addEventListener('pageshow', () => {
    if (!w[PATCH_FLAG]) installMonkeyPatch();
  });

  w[PATCH_FLAG] = true;
}

function patchHistoryMethod(name: 'pushState' | 'replaceState'): void {
  const original = history[name];

  // Use defineProperty with non-writable so the framework can't silently
  // unwrap us — they'd have to throw. Frameworks that patch first see our
  // wrapper as the "original" they wrap, which is fine.
  const wrapped: HistoryFn = function (this: History, ...args) {
    const result = (original as HistoryFn).apply(this, args as Parameters<HistoryFn>);
    // Schedule as microtask so the framework's reducer / hydration code that
    // follows the pushState() call gets to update its router state first.
    queueMicrotask(dispatchLocationChange);
    return result;
  };

  try {
    Object.defineProperty(history, name, {
      value: wrapped,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // If defineProperty fails (some sandboxed environments), fall back to
    // direct assignment. Loses the "framework can't unwrap" guarantee but
    // still delivers the event.
    (history as unknown as Record<string, HistoryFn>)[name] = wrapped;
  }
}

function dispatchLocationChange(): void {
  // CustomEvent works in every browser we support (IE not on the list).
  window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
}

/** Exported for tests. */
export { LOCATIONCHANGE_EVENT, PATCH_FLAG };

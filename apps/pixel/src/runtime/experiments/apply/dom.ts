/**
 * DOM helpers shared by every applier.
 *
 *  - `eachMatching(selector, fn)` runs `fn` on every match now AND every match
 *    that appears later (a MutationObserver auto-disconnects on first match).
 *    Late-arriving variants are how we apply CSS to a `.buy-button` that
 *    React hasn't rendered yet.
 *
 *  - `safeQuerySelectorAll` swallows malformed selectors. Customers can paste
 *    nearly anything into the admin UI; we should refuse to crash on `.foo[`.
 */

const MUTATION_OBSERVER_TIMEOUT_MS = 10_000;

/** Run `fn` on every current and future match for `selector`, capped by timeout. */
export function eachMatching(
  selector: string,
  fn: (el: Element) => void,
  timeoutMs: number = MUTATION_OBSERVER_TIMEOUT_MS,
): () => void {
  const seen = new WeakSet<Element>();

  const tryApply = (root: ParentNode): void => {
    for (const el of safeQuerySelectorAll(root, selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      try {
        fn(el);
      } catch {
        // A throwing applier shouldn't abort the cycle; just skip this node.
      }
    }
  };

  // Apply against existing DOM.
  if (typeof document !== 'undefined' && document.body) {
    tryApply(document);
  }

  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  // Watch for late-rendered nodes.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) {
          // The added node itself might match.
          if (matchesSafe(node, selector)) {
            if (!seen.has(node)) {
              seen.add(node);
              try {
                fn(node);
              } catch {
                // ignore
              }
            }
          }
          // Or any descendant.
          tryApply(node);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const stopper = setTimeout(() => observer.disconnect(), timeoutMs);

  return () => {
    observer.disconnect();
    clearTimeout(stopper);
  };
}

export function safeQuerySelectorAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

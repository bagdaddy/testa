/**
 * Goal detection — 3.3.3 parity for `createClickGoalSelectors`,
 * `validatePageViewGoal`, and the custom-goal branch of `pushEvent`.
 *
 * Three goal types, three matching strategies:
 *   - `click`     → attach a listener to the goal's CSS selector (retry a few
 *                   times for late-rendered elements). Fires on a real click.
 *                   We deliberately do NOT autocapture every click — only the
 *                   configured selectors — so ClickHouse never sees a firehose.
 *   - `page_view` → evaluate the current URL against the goal pattern once per
 *                   cycle; fire immediately on match.
 *   - `custom`    → registered in a name→goals map; fired when the customer
 *                   emits a matching custom event (via `_testa.track` /
 *                   `Analytica.pushEvent`).
 *
 * On any match we emit `track('conversion', { goal_id, experiment_id,
 * variation_id, ... })` → the durable outbox → ClickHouse, where attribution is
 * a query-time join on visitor_id. (We do NOT push to the GTM dataLayer on
 * conversion — only on exposure; see legacy/data-layer.ts.)
 *
 * The controller is fed the assigned experiments each experiment cycle and
 * returns a teardown that removes listeners + pending retry timers, so a SPA
 * route change doesn't leave stale click handlers piling up.
 */

import type { GoalConfig, MatchType } from '@testa-platform/shared-types';

/** 3.3.3 `CLICK_SELECTOR_TIMEOUT` / `CLICK_SELECTOR_MAX_TRIES`. */
const CLICK_RETRY_MS = 100;
const CLICK_MAX_TRIES = 3;
/** 3.3.3 waits 650ms before wiring click selectors (let the page settle). */
const CLICK_SETUP_DELAY_MS = 650;

export interface AssignedExperiment {
  experimentId: number;
  variationId: number;
  goals: GoalConfig[];
}

export interface GoalDeps {
  /** Emit an event through the normal track pipeline (outbox → ClickHouse). */
  track: (name: string, props?: Record<string, unknown>) => void;
}

export type Teardown = () => void;

/**
 * Match a URL against a goal pattern (3.3.3 `urlMatches`, minus `site_wide`
 * which isn't a goal match type). Defaults to `contains` when unspecified.
 */
export function urlMatchesGoal(
  currentUrl: string,
  pattern: string,
  matchType?: MatchType,
): boolean {
  switch (matchType) {
    case 'exact':
      return currentUrl === pattern;
    case 'not_contains':
      return !currentUrl.includes(pattern);
    case 'regex':
      try {
        return new RegExp(pattern).test(currentUrl);
      } catch {
        return false;
      }
    default:
      return currentUrl.includes(pattern);
  }
}

function fireConversion(
  exp: AssignedExperiment,
  goal: GoalConfig,
  deps: GoalDeps,
  data?: Record<string, unknown>,
): void {
  // Conversion goes to ClickHouse via the outbox; attribution is a query-time
  // join on visitor_id. We do NOT push `analytica_conversion` to the GTM
  // dataLayer — the customer builds GTM triggers on their own fired events, so
  // that push was redundant. (Only the exposure `Analytica` push is kept.)
  deps.track('conversion', {
    goal_id: goal.goal_id,
    experiment_id: exp.experimentId,
    variation_id: exp.variationId,
    ...(data ?? {}),
  });
}

/**
 * Wire click listeners for a single click goal, retrying while the target
 * element hasn't rendered yet. Returns a teardown that both cancels a pending
 * retry timer and removes an attached listener.
 */
function setupClickGoal(exp: AssignedExperiment, goal: GoalConfig, deps: GoalDeps): Teardown {
  if (typeof document === 'undefined') return () => {};

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanup: Teardown = () => {};

  const attach = (tries: number): void => {
    const el = document.querySelector(goal.action);
    if (!el) {
      if (tries + 1 >= CLICK_MAX_TRIES) return;
      retryTimer = setTimeout(() => attach(tries + 1), CLICK_RETRY_MS);
      return;
    }
    const handler = (): void => fireConversion(exp, goal, deps);
    el.addEventListener('click', handler);
    cleanup = () => el.removeEventListener('click', handler);
  };

  const setupTimer = setTimeout(() => attach(0), CLICK_SETUP_DELAY_MS);

  return () => {
    clearTimeout(setupTimer);
    if (retryTimer) clearTimeout(retryTimer);
    cleanup();
  };
}

interface CustomGoalEntry {
  exp: AssignedExperiment;
  goal: GoalConfig;
}

export interface GoalController {
  /** Register all goals for the assigned experiments in this cycle. */
  register: (assigned: AssignedExperiment[], currentUrl: string) => void;
  /**
   * Fire any custom goal whose `action` matches the emitted event name.
   * Called from the customer event entry points (`_testa.track` / `pushEvent`).
   */
  handleCustomEvent: (name: string, data?: Record<string, unknown>) => void;
  /** Remove all listeners + pending timers + custom registry from this cycle. */
  teardown: () => void;
}

/**
 * Create a per-cycle goal controller. Feed it the assigned experiments; it
 * wires click + page_view goals immediately and holds a registry of custom
 * goals for `handleCustomEvent` to match against. Matches the codebase's
 * factory-function convention (cf. `createEventEmitter`).
 */
export function createGoalController(deps: GoalDeps): GoalController {
  let teardowns: Teardown[] = [];
  let customGoals: CustomGoalEntry[] = [];

  return {
    register(assigned, currentUrl) {
      for (const exp of assigned) {
        for (const goal of exp.goals) {
          switch (goal.type) {
            case 'click':
              teardowns = [...teardowns, setupClickGoal(exp, goal, deps)];
              break;
            case 'page_view':
              if (urlMatchesGoal(currentUrl, goal.action, goal.match_type)) {
                fireConversion(exp, goal, deps);
              }
              break;
            case 'custom':
              customGoals = [...customGoals, { exp, goal }];
              break;
          }
        }
      }
    },

    handleCustomEvent(name, data) {
      for (const { exp, goal } of customGoals) {
        if (goal.action === name) {
          fireConversion(exp, goal, deps, data);
        }
      }
    },

    teardown() {
      for (const t of teardowns) {
        try {
          t();
        } catch {
          // ignore
        }
      }
      teardowns = [];
      customGoals = [];
    },
  };
}

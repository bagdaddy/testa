/**
 * Variation traffic assignment + frequency cap + mutex group guards.
 *
 * Rules of the road (per project memory `architecture_variation_bucketing.md`
 * and `architecture_freq_cap_mutex.md`):
 *
 *   1. Cookie-first lookup. If `_testa_exp_<id>` already has a variation that
 *      still exists in the experiment's variation list, return it without
 *      re-bucketing. This is what keeps mid-experiment 3.6 visitors stable
 *      after the cutover and what makes assignment "sticky."
 *
 *   2. Frequency cap and mutex group are guards BEFORE bucketing. A visitor
 *      who has already hit their cap or is already in the mutex group's
 *      experiment will be excluded — no `experiment_view` fired, no variation
 *      applied.
 *
 *   3. Bucketing is `xxhash32(visitor_id + ':' + experiment_id, SEED) mod 100`.
 *      Deterministic. SRM-free. Cross-device consistent when the visitor's
 *      `_testa_uuid` is preserved.
 *
 *   4. Traffic allocation is consumed BEFORE variation weights:
 *
 *        bucket [0, 100 - traffic_allocation)  → excluded
 *        bucket [100 - traffic_allocation, 100) → in the experiment, then bucket
 *                                                  the remainder over the
 *                                                  variations' cumulative weights.
 */

import { SEED, xxhash32 } from '../../utils/xxhash.ts';
import * as cookies from '../cookies.ts';

export interface Variation {
  variation_id: number;
  /** 0..100; sum across all variations should be 100. */
  weight: number;
}

export type FrequencyWindow = 'session' | 'day' | 'week' | 'month';

export interface FrequencyCap {
  max: number;
  window: FrequencyWindow;
}

export interface Experiment {
  experiment_id: number;
  /** 0..100. Percent of the visitor pool that participates. */
  traffic_allocation: number;
  variations: Variation[];
  frequency_cap?: FrequencyCap;
  mutex_group?: string;
}

export interface AssignResult {
  variationId: number;
  isExcluded: boolean;
  /** Why this visitor was excluded, when applicable. Useful for `__pixel_debug`. */
  excludedReason?:
    | 'mutex_group_collision'
    | 'frequency_cap_exhausted'
    | 'traffic_allocation'
    | 'no_variations';
}

export interface AssignContext {
  visitorId: string;
  /** `Date.now()` injection point for tests. */
  now?: number;
}

const EXCLUDED_VARIATION_ID = -1;

/**
 * Decide which variation (if any) this visitor should see for an experiment.
 *
 * Pure-ish: writes to cookies (assignment, mutex acquisition) when a visitor
 * IS enrolled. Reads cookies for cookie-first lookup, mutex check, freq check.
 */
export function assign(experiment: Experiment, ctx: AssignContext): AssignResult {
  const now = ctx.now ?? Date.now();
  const expId = experiment.experiment_id;

  if (experiment.variations.length === 0) {
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'no_variations',
    };
  }

  // ── 1. Cookie-first lookup ─────────────────────────────────────────────
  const cached = cookies.getAssignment(expId);
  if (cached !== null && experiment.variations.some((v) => v.variation_id === cached)) {
    return { variationId: cached, isExcluded: false };
  }

  // ── 2. Mutex group check ──────────────────────────────────────────────
  if (experiment.mutex_group) {
    const holder = cookies.getMutex(experiment.mutex_group);
    if (holder !== null && holder !== expId) {
      return {
        variationId: EXCLUDED_VARIATION_ID,
        isExcluded: true,
        excludedReason: 'mutex_group_collision',
      };
    }
  }

  // ── 3. Frequency cap check ────────────────────────────────────────────
  if (experiment.frequency_cap) {
    const counter = cookies.getFreq(expId);
    const windowMs = windowDurationMs(experiment.frequency_cap.window);
    if (
      counter !== null &&
      counter.count >= experiment.frequency_cap.max &&
      now - counter.window_start_ts < windowMs
    ) {
      return {
        variationId: EXCLUDED_VARIATION_ID,
        isExcluded: true,
        excludedReason: 'frequency_cap_exhausted',
      };
    }
  }

  // ── 4. Bucket ─────────────────────────────────────────────────────────
  const bucket = bucketOf(ctx.visitorId, expId);
  const traffic = clamp(experiment.traffic_allocation, 0, 100);
  const excludedRangeEnd = 100 - traffic;
  if (bucket < excludedRangeEnd) {
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'traffic_allocation',
    };
  }

  const variation = pickByWeight(experiment.variations, bucket - excludedRangeEnd);
  if (variation === null) {
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'no_variations',
    };
  }

  // ── 5. Persist the assignment + acquire mutex ─────────────────────────
  cookies.setAssignment(expId, variation.variation_id);
  if (experiment.mutex_group) {
    cookies.setMutex(experiment.mutex_group, expId);
  }

  return { variationId: variation.variation_id, isExcluded: false };
}

/**
 * Increment a visitor's `experiment_view` count for frequency capping. Call
 * AFTER firing `experiment_view`, AFTER `assign` succeeded. Resets the window
 * if the previous one has elapsed.
 */
export function recordExposure(experiment: Experiment, now: number = Date.now()): void {
  if (!experiment.frequency_cap) return;
  const expId = experiment.experiment_id;
  const windowSec = Math.floor(windowDurationMs(experiment.frequency_cap.window) / 1000);
  const counter = cookies.getFreq(expId);
  if (
    counter === null ||
    now - counter.window_start_ts >= windowDurationMs(experiment.frequency_cap.window)
  ) {
    cookies.setFreq(expId, { count: 1, window_start_ts: now }, windowSec);
    return;
  }
  cookies.setFreq(
    expId,
    { count: counter.count + 1, window_start_ts: counter.window_start_ts },
    windowSec,
  );
}

export function bucketOf(visitorId: string, experimentId: number): number {
  return xxhash32(`${visitorId}:${experimentId}`, SEED) % 100;
}

function pickByWeight(variations: Variation[], bucketWithinIncluded: number): Variation | null {
  // Sort by variation_id for stability: weights map to deterministic ranges
  // even if the admin reorders the list in the UI.
  const sorted = [...variations].sort((a, b) => a.variation_id - b.variation_id);
  const total = sorted.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return null;
  // bucketWithinIncluded is in [0, traffic_allocation). Map to [0, total).
  const target = (bucketWithinIncluded * total) / 100;
  let cumulative = 0;
  for (const v of sorted) {
    cumulative += v.weight;
    if (target < cumulative) return v;
  }
  return sorted[sorted.length - 1] ?? null;
}

function windowDurationMs(window: FrequencyWindow): number {
  switch (window) {
    case 'session':
      // The session cookie's TTL is what really enforces this; treat as 1h.
      return 60 * 60 * 1000;
    case 'day':
      return 24 * 60 * 60 * 1000;
    case 'week':
      return 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return 30 * 24 * 60 * 60 * 1000;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

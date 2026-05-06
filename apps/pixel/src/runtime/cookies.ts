/**
 * Pixel-side cookie API.
 *
 * Owns reads + writes for every `_testa_*` cookie except `_testa_uuid` —
 * that one is set by the edge worker via `Set-Cookie` header (first-party
 * context) and we only read it here. JS writes to `_testa_uuid` are
 * forbidden because Safari ITP caps them at 7 days.
 *
 * Cookies covered (matches `docs/reference/legacy-globals-inventory.md`):
 *
 *   _testa_uuid               persistent visitor id (worker-set, JS-read-only)
 *   _testa_ses_<expId>        per-experiment session (1h sliding TTL)
 *   _testa_exp_<expId>        per-experiment variation assignment (30d)
 *   _testa_excl_<expId>       per-experiment exclusion flag (30d)
 *   _testa_user_<expId>       per-experiment first-seen timestamp (30d)
 *   _testa_freq_<expId>       per-experiment frequency-cap counter (window-bound TTL)  [4.0 new]
 *   _testa_mutex_<group>      per-mutex-group active assignment (30d)                   [4.0 new]
 *
 * Storage strategy: every write goes to document.cookie + localStorage mirror.
 * Reads check both, falling through to sessionStorage as a last resort.
 * (See `./storage.ts` for the underlying primitives.)
 */

import { SECONDS_PER_DAY, SECONDS_PER_HOUR, eraseValue, readValue, writeValue } from './storage.ts';

// ─── cookie name constants (kept in sync with legacy-globals-inventory.md) ──

export const UUID_COOKIE = '_testa_uuid';
export const SESSION_COOKIE = '_testa_ses';
export const ASSIGNMENT_COOKIE = '_testa_exp';
export const EXCLUSION_COOKIE = '_testa_excl';
export const FIRST_SEEN_COOKIE = '_testa_user';
export const FREQ_COOKIE = '_testa_freq';
export const MUTEX_COOKIE = '_testa_mutex';

export const SESSION_LENGTH_SEC = SECONDS_PER_HOUR;
export const ASSIGNMENT_TTL_SEC = 30 * SECONDS_PER_DAY;

// ─── name builders ──────────────────────────────────────────────────────────

export const sessionName = (experimentId: number | string): string =>
  `${SESSION_COOKIE}_${experimentId}`;

export const assignmentName = (experimentId: number | string): string =>
  `${ASSIGNMENT_COOKIE}_${experimentId}`;

export const exclusionName = (experimentId: number | string): string =>
  `${EXCLUSION_COOKIE}_${experimentId}`;

export const firstSeenName = (experimentId: number | string): string =>
  `${FIRST_SEEN_COOKIE}_${experimentId}`;

export const freqName = (experimentId: number | string): string => `${FREQ_COOKIE}_${experimentId}`;

export const mutexName = (groupName: string): string => `${MUTEX_COOKIE}_${groupName}`;

// ─── _testa_uuid ────────────────────────────────────────────────────────────

/**
 * Read the worker-set visitor UUID. Returns null on first visit (worker
 * mints + sets via response Set-Cookie; pixel sees it on the next pageload).
 */
export function getUuid(): string | null {
  return readValue(UUID_COOKIE);
}

// ─── per-experiment assignment ──────────────────────────────────────────────

export function getAssignment(experimentId: number | string): number | null {
  const raw = readValue(assignmentName(experimentId));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setAssignment(experimentId: number | string, variationId: number): void {
  writeValue(assignmentName(experimentId), String(variationId), {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

export function clearAssignment(experimentId: number | string): void {
  eraseValue(assignmentName(experimentId));
}

// ─── per-experiment session ─────────────────────────────────────────────────

/**
 * Returns the session cookie's stored ms timestamp, or null if absent /
 * malformed. Callers compare against Date.now() to decide if the session
 * is still active.
 */
export function getSession(experimentId: number | string): number | null {
  const raw = readValue(sessionName(experimentId));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Bump (or initialize) the session cookie to "now". 1h sliding TTL. */
export function bumpSession(experimentId: number | string): void {
  writeValue(sessionName(experimentId), String(Date.now()), {
    maxAgeSec: SESSION_LENGTH_SEC,
  });
}

// ─── per-experiment exclusion ───────────────────────────────────────────────

export function getExclusion(experimentId: number | string): boolean {
  return readValue(exclusionName(experimentId)) === '1';
}

export function setExclusion(experimentId: number | string, excluded: boolean): void {
  writeValue(exclusionName(experimentId), excluded ? '1' : '0', {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

// ─── per-experiment first-seen ──────────────────────────────────────────────

export function getFirstSeen(experimentId: number | string): number | null {
  const raw = readValue(firstSeenName(experimentId));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setFirstSeen(experimentId: number | string, ts: number): void {
  writeValue(firstSeenName(experimentId), String(ts), {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

// ─── frequency cap counter (4.0 new) ────────────────────────────────────────

export interface FreqCounter {
  count: number;
  window_start_ts: number;
}

/**
 * Read the freq counter for an experiment. Returns null if absent or if the
 * stored value is malformed. Callers are responsible for window-expiry checks
 * (compare window_start_ts to now).
 */
export function getFreq(experimentId: number | string): FreqCounter | null {
  const raw = readValue(freqName(experimentId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FreqCounter>;
    if (
      typeof parsed.count === 'number' &&
      typeof parsed.window_start_ts === 'number' &&
      Number.isFinite(parsed.count) &&
      Number.isFinite(parsed.window_start_ts)
    ) {
      return { count: parsed.count, window_start_ts: parsed.window_start_ts };
    }
  } catch {
    // fall through
  }
  return null;
}

export function setFreq(
  experimentId: number | string,
  counter: FreqCounter,
  windowDurationSec: number,
): void {
  writeValue(freqName(experimentId), JSON.stringify(counter), {
    maxAgeSec: windowDurationSec,
  });
}

export function clearFreq(experimentId: number | string): void {
  eraseValue(freqName(experimentId));
}

// ─── mutex group (4.0 new) ──────────────────────────────────────────────────

/**
 * Returns the experiment_id currently holding the mutex group, or null.
 */
export function getMutex(groupName: string): number | null {
  const raw = readValue(mutexName(groupName));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setMutex(groupName: string, experimentId: number): void {
  writeValue(mutexName(groupName), String(experimentId), {
    maxAgeSec: ASSIGNMENT_TTL_SEC,
  });
}

export function clearMutex(groupName: string): void {
  eraseValue(mutexName(groupName));
}

// ─── bulk wipe (test + integration helper) ──────────────────────────────────

/**
 * Erase EVERY `_testa_*` cookie that we know about for the given experiment.
 * UUID is not touched (worker owns it).
 *
 * Useful for QA flows ("reset me to a fresh visitor for this experiment")
 * and for the consent-revoke path (Phase 3.4).
 */
export function clearExperiment(experimentId: number | string): void {
  eraseValue(assignmentName(experimentId));
  eraseValue(exclusionName(experimentId));
  eraseValue(firstSeenName(experimentId));
  eraseValue(freqName(experimentId));
  eraseValue(sessionName(experimentId));
}

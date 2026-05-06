/**
 * Low-level storage helpers used by the cookies module.
 *
 * Strategy mirrors 3.6: document.cookie is the canonical store, but every
 * write is mirrored to localStorage. Reads check document.cookie first,
 * then localStorage, then sessionStorage. This survives Safari ITP's
 * 7-day cap on JS-set cookies — the localStorage mirror keeps the value
 * accessible even after the cookie has been silently dropped.
 *
 * `_testa_uuid` is the exception: that cookie is set by the edge worker
 * via `Set-Cookie` header (first-party context) and we never write it from
 * JS. We only READ it here.
 */

/** Default expiry units (seconds). 0 / negative → session cookie. */
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86_400;

export interface StorageOptions {
  /** Expiry in seconds. 0 / undefined → session cookie. */
  maxAgeSec?: number;
  /** `Domain=...` attribute. Empty → don't set. */
  domain?: string;
  /** Path. Defaults to '/'. */
  path?: string;
}

/**
 * Get a cookie / mirrored value by name. Returns null if absent across all
 * three stores.
 *
 *   1. document.cookie        canonical
 *   2. localStorage           mirror; survives ITP eviction of cookie
 *   3. sessionStorage         tab-scoped fallback when localStorage blocked
 */
export function readValue(name: string): string | null {
  const fromCookie = readCookie(name);
  if (fromCookie !== null) return fromCookie;

  const fromLocal = safeStorageGet(localStorageRef(), name);
  if (fromLocal !== null) return fromLocal;

  return safeStorageGet(sessionStorageRef(), name);
}

/**
 * Write a value to document.cookie + localStorage mirror.
 * Failures (e.g. private browsing) are swallowed — the read path still works
 * via whichever store accepted the write.
 */
export function writeValue(name: string, value: string, opts: StorageOptions = {}): void {
  writeCookie(name, value, opts);
  safeStorageSet(localStorageRef(), name, value);
}

/**
 * Erase a value across all three stores. Safe to call on absent values.
 */
export function eraseValue(name: string, opts: StorageOptions = {}): void {
  writeCookie(name, '', { ...opts, maxAgeSec: 0 });
  safeStorageRemove(localStorageRef(), name);
  safeStorageRemove(sessionStorageRef(), name);
}

// ─── document.cookie ───────────────────────────────────────────────────

function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      const raw = trimmed.slice(prefix.length);
      // Empty value (after Max-Age=0 erase, or genuinely empty) → treat as absent
      // so the localStorage / sessionStorage fallbacks get a chance.
      if (raw === '') return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function writeCookie(name: string, value: string, opts: StorageOptions): void {
  if (typeof document === 'undefined') return;
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAgeSec !== undefined && opts.maxAgeSec >= 0) {
    segments.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
    if (opts.maxAgeSec > 0) {
      const expires = new Date(Date.now() + opts.maxAgeSec * 1000).toUTCString();
      segments.push(`expires=${expires}`);
    }
  }
  segments.push(`path=${opts.path ?? '/'}`);
  if (opts.domain) {
    segments.push(`domain=${opts.domain}`);
  }
  segments.push('SameSite=Lax');
  if (typeof location !== 'undefined' && location.protocol === 'https:') {
    segments.push('Secure');
  }
  try {
    document.cookie = segments.join('; ');
  } catch {
    // Ignore — we'll fall back to localStorage.
  }
}

// ─── localStorage / sessionStorage with try-safe wrappers ───────────────

function localStorageRef(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function sessionStorageRef(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function safeStorageGet(store: Storage | null, name: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(name);
  } catch {
    return null;
  }
}

function safeStorageSet(store: Storage | null, name: string, value: string): void {
  if (!store) return;
  try {
    store.setItem(name, value);
  } catch {
    // Quota / private mode → skip silently.
  }
}

function safeStorageRemove(store: Storage | null, name: string): void {
  if (!store) return;
  try {
    store.removeItem(name);
  } catch {
    // ignore
  }
}

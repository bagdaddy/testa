/**
 * Client-side browser / OS detection for audience targeting.
 *
 * Hand-rolled rather than pulling in `ua-parser-js` (which the edge uses) so the
 * runtime stays under its gzip size budget — same trade-off as `detectDeviceType`
 * in `lifecycle.ts`. These feed the `device.browser` / `device.os` audience facts,
 * which are matched with case-sensitive `in` / `notIn`, so the returned strings
 * are a fixed canonical vocabulary chosen to line up with the names `ua-parser-js`
 * emits at the edge (`browser.name`, `os.name`). Empty string == unknown, which
 * never matches an `in` rule (and always matches `notIn`).
 *
 * FIRST-PASS vocabulary. The authoritative source of truth for the values a
 * customer can pick is crobot's rule-builder UI (out of this repo); exact
 * alignment with it — and with `ua-parser-js`'s mobile-variant names
 * ("Mobile Safari", etc.) — is deferred. We normalise mobile variants to their
 * base browser here ("Mobile Safari" → "Safari") since "is it Safari" is the
 * targeting question that matters; revisit when the crobot vocabulary is pinned.
 *
 * Pure functions (UA passed in) so they unit-test without a DOM.
 */

export type Browser =
  | 'Chrome'
  | 'Safari'
  | 'Firefox'
  | 'Edge'
  | 'Opera'
  | 'Samsung Internet'
  | 'IE'
  | '';

export type Os = 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Linux' | 'Chrome OS' | '';

/**
 * Detect the browser from a User-Agent string.
 *
 * Order is load-bearing: Edge / Opera / Samsung / Chrome-on-iOS UAs all also
 * carry a `Chrome` or `Safari` token, so the more specific brands must be tested
 * before the generic Chrome/Safari fallbacks.
 */
export function detectBrowser(ua: string): Browser {
  if (!ua) return '';

  // iOS browsers are all WebKit, distinguished only by an injected brand token.
  if (/CriOS\//.test(ua)) return 'Chrome';
  if (/FxiOS\//.test(ua)) return 'Firefox';
  if (/EdgiOS\//.test(ua)) return 'Edge';
  if (/OPiOS\//.test(ua)) return 'Opera';

  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/OPR\/|Opera\//.test(ua)) return 'Opera';
  // Chromium Edge ("Edg/"), legacy Edge ("Edge/"), Android Edge ("EdgA/").
  if (/Edg(e|A)?\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/MSIE |Trident\//.test(ua)) return 'IE';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';

  return '';
}

/**
 * Detect the OS family from a User-Agent string. Version is intentionally
 * dropped — audience rules target the family ("macOS"), not "macOS 14.4".
 *
 * Order is load-bearing: Android UAs contain `Linux`; Chrome OS contains both;
 * iOS must precede macOS. Note iPadOS Safari reports as `Macintosh` and will be
 * detected as `macOS` — a known UA-spoofing limitation we accept for now.
 */
export function detectOs(ua: string): Os {
  if (!ua) return '';

  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';

  return '';
}

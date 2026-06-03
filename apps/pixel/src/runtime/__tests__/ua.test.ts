import { describe, expect, it } from 'vitest';
import { type Browser, type Os, detectBrowser, detectOs } from '../ua.ts';

// Real-world UA strings. The ordering hazards are deliberate: Edge / Opera /
// Samsung / Chrome-on-iOS all also carry a "Chrome" or "Safari" token, so these
// cases prove the brand checks win over the generic fallbacks.
const CASES: ReadonlyArray<{ name: string; ua: string; browser: Browser; os: Os }> = [
  {
    name: 'Chrome on Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    browser: 'Chrome',
    os: 'Windows',
  },
  {
    name: 'Safari on macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    browser: 'Safari',
    os: 'macOS',
  },
  {
    name: 'Firefox on Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    browser: 'Firefox',
    os: 'Linux',
  },
  {
    name: 'Chromium Edge on Windows (has Chrome + Safari tokens)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    browser: 'Edge',
    os: 'Windows',
  },
  {
    name: 'Opera on Windows (has Chrome token)',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
    browser: 'Opera',
    os: 'Windows',
  },
  {
    name: 'Samsung Internet on Android (has Chrome token)',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    browser: 'Samsung Internet',
    os: 'Android',
  },
  {
    name: 'Chrome on Android (Linux token must not win)',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    browser: 'Chrome',
    os: 'Android',
  },
  {
    name: 'Mobile Safari on iOS (normalised to Safari)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    browser: 'Safari',
    os: 'iOS',
  },
  {
    name: 'Chrome on iOS (CriOS, Mac OS X token must not become macOS)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
    browser: 'Chrome',
    os: 'iOS',
  },
  {
    name: 'Chrome on Chrome OS',
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    browser: 'Chrome',
    os: 'Chrome OS',
  },
  {
    name: 'Legacy IE11',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko',
    browser: 'IE',
    os: 'Windows',
  },
];

describe('detectBrowser', () => {
  for (const c of CASES) {
    it(`detects ${c.browser || '(unknown)'} for ${c.name}`, () => {
      expect(detectBrowser(c.ua)).toBe(c.browser);
    });
  }

  it('returns empty string for an empty UA', () => {
    expect(detectBrowser('')).toBe('');
  });

  it('returns empty string for an unrecognised UA', () => {
    expect(detectBrowser('SomeRandomCrawler/1.0')).toBe('');
  });
});

describe('detectOs', () => {
  for (const c of CASES) {
    it(`detects ${c.os || '(unknown)'} for ${c.name}`, () => {
      expect(detectOs(c.ua)).toBe(c.os);
    });
  }

  it('returns empty string for an empty UA', () => {
    expect(detectOs('')).toBe('');
  });
});

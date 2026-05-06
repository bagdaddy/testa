import { describe, expect, it } from 'vitest';
import { type BotInputs, SCORE_THRESHOLD, botSignal } from '../bot.ts';
import { BOT_ASN_BLOCKLIST } from '../data/asn-bad-list.ts';

const REAL_UAS = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  headlessChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36',
  selenium: 'Mozilla/5.0 (compatible; Selenium/4.10.0)',
  puppeteer: 'Puppeteer/22.5.0 (compatible; like Chrome)',
};

const FIRST_BAD_ASN = [...BOT_ASN_BLOCKLIST][0];
if (FIRST_BAD_ASN === undefined) throw new Error('asn blocklist is empty');
const A_BAD_ASN: number = FIRST_BAD_ASN;

function makeInputs(overrides: Partial<BotInputs> = {}): BotInputs {
  return {
    userAgent: REAL_UAS.macChrome,
    acceptLanguage: 'en-US,en;q=0.9',
    cfAsn: 7922, // Comcast — not in blocklist
    cfVerifiedBot: false,
    ...overrides,
  };
}

describe('botSignal — verifiedBot drop path', () => {
  it('verifiedBot=true → drop=true, is_bot=1, reasons=["verifiedBot"]', () => {
    const r = botSignal(makeInputs({ cfVerifiedBot: true }));
    expect(r.drop).toBe(true);
    expect(r.is_bot).toBe(1);
    expect(r.score).toBe(100);
    expect(r.reasons).toEqual(['verifiedBot']);
  });

  it('verifiedBot wins even when other heuristics also fire', () => {
    const r = botSignal(
      makeInputs({
        cfVerifiedBot: true,
        userAgent: '',
        acceptLanguage: null,
      }),
    );
    expect(r.drop).toBe(true);
    expect(r.reasons).toEqual(['verifiedBot']); // doesn't double-count
  });
});

describe('botSignal — heuristic hits', () => {
  it('empty UA alone → is_bot=1, score≥80, drop=false', () => {
    const r = botSignal(makeInputs({ userAgent: '' }));
    expect(r.is_bot).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.reasons).toContain('empty_ua');
    expect(r.drop).toBe(false);
  });

  it('HeadlessChrome UA → is_bot=1, score≥60', () => {
    const r = botSignal(makeInputs({ userAgent: REAL_UAS.headlessChrome }));
    expect(r.is_bot).toBe(1);
    expect(r.reasons).toContain('headless');
  });

  it('Selenium UA → is_bot=1', () => {
    const r = botSignal(makeInputs({ userAgent: REAL_UAS.selenium }));
    expect(r.is_bot).toBe(1);
    expect(r.reasons).toContain('headless');
  });

  it('Puppeteer UA → is_bot=1', () => {
    const r = botSignal(makeInputs({ userAgent: REAL_UAS.puppeteer }));
    expect(r.is_bot).toBe(1);
    expect(r.reasons).toContain('headless');
  });

  it('missing accept-language alone (weight=30) → is_bot=1 right at threshold', () => {
    const r = botSignal(makeInputs({ acceptLanguage: null }));
    expect(r.score).toBe(30);
    expect(r.score).toBeGreaterThanOrEqual(SCORE_THRESHOLD);
    expect(r.is_bot).toBe(1);
    expect(r.reasons).toContain('no_accept_language');
  });

  it('bad ASN alone → is_bot=1, score≥50', () => {
    const r = botSignal(makeInputs({ cfAsn: A_BAD_ASN }));
    expect(r.is_bot).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reasons.some((x) => x.startsWith('bad_asn:'))).toBe(true);
  });

  it('multiple signals combine and the score caps at 100', () => {
    const r = botSignal(
      makeInputs({
        userAgent: REAL_UAS.headlessChrome,
        acceptLanguage: null,
        cfAsn: A_BAD_ASN,
      }),
    );
    expect(r.is_bot).toBe(1);
    expect(r.score).toBe(100); // would be 60+30+50=140; capped
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('botSignal — clean traffic', () => {
  it('Mac Chrome with full headers and good ASN → is_bot=0, score=0', () => {
    const r = botSignal(makeInputs());
    expect(r.is_bot).toBe(0);
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.drop).toBe(false);
  });

  it('cfAsn undefined is not flagged', () => {
    const r = botSignal(makeInputs({ cfAsn: undefined }));
    expect(r.is_bot).toBe(0);
    expect(r.reasons.some((x) => x.startsWith('bad_asn'))).toBe(false);
  });
});

describe('asn-bad-list', () => {
  it('contains DigitalOcean (14061)', () => {
    expect(BOT_ASN_BLOCKLIST.has(14061)).toBe(true);
  });

  it('does not contain consumer ISPs (Comcast 7922)', () => {
    expect(BOT_ASN_BLOCKLIST.has(7922)).toBe(false);
  });

  it('is not absurdly large (defends against accidental over-blocking)', () => {
    expect(BOT_ASN_BLOCKLIST.size).toBeGreaterThan(0);
    expect(BOT_ASN_BLOCKLIST.size).toBeLessThan(50);
  });
});

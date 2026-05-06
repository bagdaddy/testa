import { BOT_ASN_BLOCKLIST } from './data/asn-bad-list.ts';

/**
 * Bot-signal heuristics for the edge worker.
 *
 * v1 uses only free signals (CF's basic verifiedBot flag, UA parsing, headers,
 * ASN reputation). Paid CF Bot Management is explicitly out of scope.
 *
 * Two outcomes:
 *   - `verifiedBot`         → DROP the event entirely (don't forward to collector).
 *                              Caller returns 204 anyway so customer-side code
 *                              can't probe whether their traffic is being filtered.
 *   - heuristic hits        → TAG with `is_bot=1`, still forward.
 *                              Dashboards can include or exclude bots at query time.
 *
 * Score is informational (0–100, capped). Real decision is `is_bot` boolean.
 */

export interface BotInputs {
  userAgent: string;
  acceptLanguage: string | null;
  cfAsn: number | undefined;
  cfVerifiedBot: boolean;
}

export interface BotResult {
  is_bot: 0 | 1;
  /** Sum of triggered weights, capped at 100. Diagnostic; not the decision. */
  score: number;
  /** Which heuristics fired, in stable order. */
  reasons: string[];
  /** When true, the worker MUST NOT forward this event. Currently set only on verifiedBot. */
  drop: boolean;
}

/**
 * Threshold at which heuristic score flips `is_bot` from 0 to 1.
 * Tuned so that any single weighty signal (≥30) is enough to tag.
 */
export const SCORE_THRESHOLD = 30;

const HEADLESS_RE = /HeadlessChrome|PhantomJS|Selenium|playwright|puppeteer/i;

const WEIGHT = {
  emptyUa: 80,
  headless: 60,
  noAcceptLanguage: 30,
  badAsn: 50,
} as const;

export function botSignal(inputs: BotInputs): BotResult {
  // CF's verifiedBot signal is high-confidence and authoritative — drop unconditionally.
  if (inputs.cfVerifiedBot) {
    return { is_bot: 1, score: 100, reasons: ['verifiedBot'], drop: true };
  }

  const reasons: string[] = [];
  let score = 0;

  if (!inputs.userAgent) {
    reasons.push('empty_ua');
    score += WEIGHT.emptyUa;
  }
  if (inputs.userAgent && HEADLESS_RE.test(inputs.userAgent)) {
    reasons.push('headless');
    score += WEIGHT.headless;
  }
  if (!inputs.acceptLanguage) {
    reasons.push('no_accept_language');
    score += WEIGHT.noAcceptLanguage;
  }
  if (inputs.cfAsn !== undefined && BOT_ASN_BLOCKLIST.has(inputs.cfAsn)) {
    reasons.push(`bad_asn:${inputs.cfAsn}`);
    score += WEIGHT.badAsn;
  }

  const cappedScore = Math.min(score, 100);
  return {
    is_bot: score >= SCORE_THRESHOLD ? 1 : 0,
    score: cappedScore,
    reasons,
    drop: false,
  };
}

/** Helper for the route handler: extract `BotInputs` from a Workers `Request`. */
export function botInputsFromRequest(request: Request): BotInputs {
  type CfWithBot = {
    asn?: number;
    botManagement?: { verifiedBot?: boolean };
  };
  const cf = (request as Request & { cf?: CfWithBot }).cf ?? {};
  return {
    userAgent: request.headers.get('user-agent') ?? '',
    acceptLanguage: request.headers.get('accept-language'),
    cfAsn: cf.asn,
    cfVerifiedBot: cf.botManagement?.verifiedBot === true,
  };
}

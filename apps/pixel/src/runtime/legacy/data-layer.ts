/**
 * GTM `window.dataLayer` push — 3.3.3 parity for `trackLead` / `trackConversion`.
 *
 * Many customers wire their GTM triggers to the events 3.6 pushed onto
 * `window.dataLayer`, so we keep pushing the exact same shapes:
 *   - `{ event: 'Analytica', ExperimentId, ExperimentName, VariationId, VariationName }`
 *     on exposure (a visitor is bucketed into a variation), and
 *   - `{ event: 'analytica_conversion', goalName, goalId }` on a goal match.
 *
 * This is the *real-time* signal for GTM; ClickHouse still receives the raw
 * events for query-time attribution. The two are complementary — GTM can't
 * wait for an analytics query, so the pixel matches goals client-side and
 * pushes here the instant they fire.
 *
 * Reference: 3.3.3 `script.js` `trackLead` (~921) and `trackConversion` (~940).
 */

/** 3.3.3 `CONTROL_IDENTIFIER` — variation 0 is always the control. */
const CONTROL_IDENTIFIER = 0;

interface DataLayerWindow {
  dataLayer?: Array<Record<string, unknown>>;
}

function ensureDataLayer(): Array<Record<string, unknown>> | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as DataLayerWindow;
  if (!Array.isArray(w.dataLayer)) {
    w.dataLayer = [];
  }
  return w.dataLayer;
}

/** Human-readable variation label, matching 3.3.3: Control for id 0, else the
 * configured name or `Variation<id>`. */
export function variationName(variationId: number, configuredName?: string): string {
  if (variationId === CONTROL_IDENTIFIER) return 'Control';
  return configuredName && configuredName.length > 0 ? configuredName : `Variation${variationId}`;
}

/**
 * Push the exposure ("lead") record onto the GTM dataLayer. 3.3.3 `trackLead`.
 * No-op when there's no `window` (SSR/tests without DOM).
 */
export function pushLeadToDataLayer(params: {
  experimentId: number;
  experimentName?: string;
  variationId: number;
  variationName?: string;
}): void {
  const dl = ensureDataLayer();
  if (!dl) return;
  dl.push({
    event: 'Analytica',
    ExperimentId: params.experimentId,
    ExperimentName: params.experimentName ?? '',
    VariationId: params.variationId,
    VariationName: variationName(params.variationId, params.variationName),
  });
}

/**
 * Push a conversion record onto the GTM dataLayer. 3.3.3 `trackConversion`.
 * No-op when there's no `window`.
 */
export function pushConversionToDataLayer(params: { goalId: number; goalName?: string }): void {
  const dl = ensureDataLayer();
  if (!dl) return;
  dl.push({
    event: 'analytica_conversion',
    goalName: params.goalName ?? '',
    goalId: params.goalId,
  });
}

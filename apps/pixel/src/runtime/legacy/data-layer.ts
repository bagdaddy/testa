/**
 * GTM `window.dataLayer` push — 3.3.3 parity for `trackLead` (exposure).
 *
 * Many customers wire their GTM triggers to the exposure event 3.6 pushed onto
 * `window.dataLayer`, so we keep pushing the exact same shape:
 *   `{ event: 'Analytica', ExperimentId, ExperimentName, VariationId, VariationName }`
 * when a visitor is bucketed into a variation. This is the real-time segmentation
 * signal for GTM; ClickHouse still receives the raw `experiment_view` event.
 *
 * We deliberately do NOT push a conversion event (`analytica_conversion`) — it
 * was redundant. Conversions flow to ClickHouse via the `conversion` event, and
 * customers build GTM conversion triggers on their own fired events.
 *
 * Reference: 3.3.3 `script.js` `trackLead` (~921).
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

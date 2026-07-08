import { beforeEach, describe, expect, it } from 'vitest';
import { pushConversionToDataLayer, pushLeadToDataLayer, variationName } from '../data-layer.ts';

interface DlWindow {
  dataLayer?: Array<Record<string, unknown>> | undefined;
}

beforeEach(() => {
  (window as unknown as DlWindow).dataLayer = undefined;
});

describe('variationName', () => {
  it('labels the control, configured names, and the fallback', () => {
    expect(variationName(0)).toBe('Control');
    expect(variationName(0, 'Ignored')).toBe('Control');
    expect(variationName(3, 'Hero A')).toBe('Hero A');
    expect(variationName(3)).toBe('Variation3');
    expect(variationName(3, '')).toBe('Variation3');
  });
});

describe('pushLeadToDataLayer', () => {
  it('creates window.dataLayer and pushes the 3.3.3 Analytica shape', () => {
    pushLeadToDataLayer({
      experimentId: 7,
      experimentName: 'Homepage CTA',
      variationId: 2,
      variationName: 'Green',
    });
    const dl = (window as unknown as DlWindow).dataLayer;
    expect(dl).toEqual([
      {
        event: 'Analytica',
        ExperimentId: 7,
        ExperimentName: 'Homepage CTA',
        VariationId: 2,
        VariationName: 'Green',
      },
    ]);
  });

  it('defaults name fields and derives the variation label', () => {
    pushLeadToDataLayer({ experimentId: 1, variationId: 0 });
    const entry = (window as unknown as DlWindow).dataLayer?.[0];
    expect(entry?.ExperimentName).toBe('');
    expect(entry?.VariationName).toBe('Control');
  });
});

describe('pushConversionToDataLayer', () => {
  it('pushes the analytica_conversion shape onto an existing dataLayer', () => {
    (window as unknown as DlWindow).dataLayer = [{ event: 'prior' }];
    pushConversionToDataLayer({ goalId: 42, goalName: 'Signup' });
    const dl = (window as unknown as DlWindow).dataLayer;
    expect(dl?.[1]).toEqual({ event: 'analytica_conversion', goalName: 'Signup', goalId: 42 });
  });

  it('defaults goalName when absent', () => {
    pushConversionToDataLayer({ goalId: 42 });
    expect((window as unknown as DlWindow).dataLayer?.[0]?.goalName).toBe('');
  });
});

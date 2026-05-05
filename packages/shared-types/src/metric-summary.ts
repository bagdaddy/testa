/**
 * Pre-aggregated metric responses returned by the collector's read API.
 * crobot consumes these via MetricsProxyController -> CollectorClient.
 */

export type ReportCurrency = string; // ISO 4217, e.g. 'USD'

export interface MetricRequestBase {
  experiment_id: number;
  from?: string; // ISO date
  to?: string; // ISO date
  report_currency: ReportCurrency;
}

export interface VariationMetric {
  variation_id: number;
  sample_size: number;
}

export interface AovMetric extends VariationMetric {
  aov: number; // average order value in report_currency
  ci_low: number;
  ci_high: number;
  total_revenue: number;
  orders: number;
}

export interface RpvMetric extends VariationMetric {
  rpv: number; // revenue per visitor in report_currency
  ci_low: number;
  ci_high: number;
  total_revenue: number;
  visitors: number;
}

export interface SessionsMetric extends VariationMetric {
  sessions: number;
  bounce_rate: number;
  pages_per_session: number;
}

export interface FunnelStep {
  event_name: string;
  count: number;
  rate_from_prev: number; // 0..1
}

export interface FunnelMetric extends VariationMetric {
  steps: FunnelStep[];
}

/**
 * Significance test result attached to AOV / RPV deltas vs a reference variation
 * (typically control). Welch's t-test for AOV, bootstrap for RPV.
 */
export interface SignificanceResult {
  reference_variation_id: number;
  compared_variation_id: number;
  delta: number;
  delta_relative: number; // (compared - ref) / ref
  p_value: number;
  is_significant: boolean; // p < 0.05 by default
}

export interface MetricSummary<T extends VariationMetric> {
  experiment_id: number;
  report_currency: ReportCurrency;
  from: string;
  to: string;
  variations: T[];
  significance?: SignificanceResult[];
}

export type AovSummary = MetricSummary<AovMetric>;
export type RpvSummary = MetricSummary<RpvMetric>;
export type SessionsSummary = MetricSummary<SessionsMetric>;
export type FunnelSummary = MetricSummary<FunnelMetric>;

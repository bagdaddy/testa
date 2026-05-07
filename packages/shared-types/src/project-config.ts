/**
 * Shape of the JSON config crobot publishes to CF KV per project.
 * Edge worker reads this on `GET /projects/:slug.js` and inlines it into the
 * served pixel runtime as `window.cfPrefill.project`.
 */

import type { AudienceCondition } from './audience.ts';

export type IntegrationVersion = '3.4' | '3.6' | '4.0';

export type ConsentMode = 'aware' | 'strict';

export type GoalType = 'click' | 'page_view' | 'custom';

export type MatchType = 'exact' | 'contains' | 'not_contains' | 'regex';

export interface ProjectConfig {
  project_id: number;
  slug: string;
  integration_version: IntegrationVersion;
  consent_mode: ConsentMode;
  /** Optional first-party tracking domain (CNAME); when set, edge serves cookies as Domain=.{customer-domain}. */
  tracking_domain?: string;
  experiments: ExperimentConfig[];
  /** ISO timestamp of the last config publish; used as cache-buster for the served bundle. */
  published_at: string;
  /** Content hash of the experiments array; included in the served JS URL for cache invalidation. */
  config_hash: string;
}

export interface ExperimentConfig {
  experiment_id: number;
  status: 'active' | 'paused' | 'archived';
  rules: ExperimentRule[];
  variations: VariationConfig[];
  goals: GoalConfig[];
  /** 0..100 share of eligible visitors who participate. Remaining are excluded. */
  traffic_allocation: number;
  /** Optional audience targeting tree (Tier 1+2 dimensions). 4.0 only. */
  audience?: AudienceCondition;
  /** Optional per-experiment frequency cap. 4.0 only. */
  frequency_cap?: { max: number; window: 'session' | 'day' | 'week' | 'month' };
  /** Optional mutex-group name. Visitor in ≤1 active experiment per group. 4.0 only. */
  mutex_group?: string;
}

export interface ExperimentRule {
  match_type: MatchType;
  url_pattern: string;
}

export interface VariationConfig {
  variation_id: number;
  weight: number;
  /** Visual/code changes the runtime applies for this variation; opaque to the type system. */
  changes: VariationChange[];
}

export type VariationChange =
  | { type: 'css'; selector: string; styles: Record<string, string> }
  | { type: 'html'; selector: string; html: string }
  | { type: 'text'; selector: string; text: string }
  | { type: 'js'; code: string }
  | { type: 'redirect'; from_url: string; to_url: string }
  | { type: 'attribute'; selector: string; name: string; value: string };

export interface GoalConfig {
  goal_id: number;
  type: GoalType;
  match_type?: MatchType;
  action: string;
}

/**
 * `resolveExposures` — which experiments the visitor is exposed to right now.
 *
 * This is what fires `variation_applied` (client event surface + the GTM
 * dataLayer), so a miss here is silent: results still populate from the
 * exposure POST, while every downstream analytics consumer sees nothing.
 *
 * The case that was missing: a split-URL VARIANT visitor. The page rule is
 * written against the control URL, and the redirect puts them somewhere it was
 * never meant to match — so they produced no exposure anywhere. They had left
 * the control page before the apply step, and the destination failed the gate.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { resolveExposures } from '../engine.ts';

const NOW = 1_800_000_000;
const SESSION_END = NOW + 1800;

/** `expId.variation.excluded.sessionExp` */
const cookie = (variation: number): string => `77.${variation}.0.${SESSION_END}`;

/** A funnel-shaped split URL: the rule matches the control page only. */
function funnelConfig(
  over: {
    rule?: string;
    from?: string;
    to?: string;
    mode?: 'exact' | 'contains' | 'query' | 'regex';
  } = {},
): ProjectConfig {
  return {
    project_id: 1,
    slug: 'acme',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '2026-08-04T00:00:00.000Z',
    config_hash: 'h1',
    experiments: [
      {
        experiment_id: 77,
        title: 'Question funnel',
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'contains', url_pattern: over.rule ?? '/question/male' }],
        goals: [],
        variations: [
          { variation_id: 0, weight: 50, changes: [] },
          {
            variation_id: 1,
            weight: 50,
            changes: [
              {
                type: 'redirect',
                from_url: over.from ?? 'https://acme.com/question/male/1',
                to_url: over.to ?? 'https://acme.com/question/female/1',
                url_match_type: over.mode ?? 'exact',
              },
            ],
          },
        ],
      },
    ],
  };
}

const at = (url: string, variation: number): ReturnType<typeof resolveExposures> =>
  resolveExposures(funnelConfig(), cookie(variation), url, NOW);

describe('resolveExposures', () => {
  it('reports the control visitor on the page the rule matches', () => {
    expect(at('https://acme.com/question/male/1', 0)).toEqual([
      { experimentId: 77, variationId: 0, title: 'Question funnel' },
    ]);
  });

  it('reports the VARIANT visitor standing on the redirect destination', () => {
    // `/question/female/1` matches no page rule — being at the destination of a
    // redirect you are assigned to is itself the exposure.
    expect(at('https://acme.com/question/female/1', 1)).toEqual([
      { experimentId: 77, variationId: 1, title: 'Question funnel' },
    ]);
  });

  it('ignores the destination when the visitor is assigned to control', () => {
    expect(at('https://acme.com/question/female/1', 0)).toEqual([]);
  });

  it('reports nothing on an unrelated page', () => {
    expect(at('https://acme.com/about', 1)).toEqual([]);
    expect(at('https://acme.com/about', 0)).toEqual([]);
  });

  it('matches the destination ignoring query params and a trailing slash', () => {
    expect(at('https://acme.com/question/female/1/?flow=7247', 1)).toHaveLength(1);
  });

  it('does not match a different host', () => {
    expect(at('https://other.com/question/female/1', 1)).toEqual([]);
  });

  it('handles a path-only to_url', () => {
    const config = funnelConfig({ to: '/question/female/1' });
    expect(
      resolveExposures(config, cookie(1), 'https://acme.com/question/female/1', NOW),
    ).toHaveLength(1);
  });

  it('reports nothing once the session window has passed', () => {
    expect(
      resolveExposures(
        funnelConfig(),
        cookie(1),
        'https://acme.com/question/female/1',
        SESSION_END + 1,
      ),
    ).toEqual([]);
  });

  // A regex split URL builds its destination from `to_url` as a TEMPLATE
  // (`/q/$1/female`), so it never compares equal to the URL the visitor is
  // actually on. Before the comparison followed `url_match_type`, that dropped
  // the WHOLE variant arm out of `variation_applied` — control kept reporting,
  // the variant reported nothing, and the split looked broken downstream.
  it('reports the variant at a REGEX-templated destination', () => {
    const config = funnelConfig({
      rule: '/question/male',
      from: 'https://acme\\.com/question/male/(\\d+)',
      to: '/question/female/$1',
      mode: 'regex',
    });
    expect(resolveExposures(config, cookie(1), 'https://acme.com/question/female/12', NOW)).toEqual(
      [{ experimentId: 77, variationId: 1, title: 'Question funnel' }],
    );
    // …and still nothing on a page the template does not describe.
    expect(resolveExposures(config, cookie(1), 'https://acme.com/about', NOW)).toEqual([]);
  });

  it('reports nothing without an assignment', () => {
    expect(resolveExposures(funnelConfig(), null, 'https://acme.com/question/male/1', NOW)).toEqual(
      [],
    );
  });
});

'use client';

/**
 * `<TestaProvider/>` — applies the visitor's DOM experiments on the client.
 * Add it once in the layout (client component); it re-applies on each App-Router
 * navigation.
 *
 * Three modes:
 *   - Normal (cookie-first): the proxy already bucketed the visitor server-side
 *     and wrote `_testa_exp`; this reads that cookie and applies the variant's
 *     DOM changes via the shared apply engine — no re-bucket.
 *   - COLD FALLBACK: the proxy had no config in memory (`decisions: 'hybrid'` on
 *     a cold isolate), never ran, or never warms — so nothing decided this
 *     pageview. Detected as a cookie gap (see `cold-decision.ts`); this then
 *     runs the FULL client engine from `@testa-soft/react`: bucket, write the
 *     assignment, issue the split-URL redirect, apply the DOM, emit the
 *     exposure. Without it a cold pageview is silently unexperimented, and
 *     because the normal path is cookie-first it stays that way on every later
 *     visit too, until an isolate happens to be warm.
 *   - Preview (`?testa_preview=true&testa_preview_token=<t>`): skips assignment,
 *     fetches the draft changes for that session from `previewApiUrl` and applies
 *     them, so an editor can see un-published changes live.
 *
 * All three reveal the anti-flicker shield (raised by `<TestaGuard/>`) once
 * done, so control content is never shown before the variant.
 *
 * The config comes from the server (`/server`'s RSC fetches it), and when that
 * fetch failed the client fetches its own — otherwise an unreachable-from-the-
 * server config host means no experiments at all, forever.
 *
 * Framework-agnostic logic lives in `apply-assignments.ts`, `preview.ts` and
 * `cold-decision.ts` (unit tested); this file is the React + App-Router glue.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  type Teardown,
  applyVariation,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
} from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE, UUID_COOKIE, resolveExposures } from '@testa-soft/experiment-core';
import { DocumentCookieStore, emitExposure, initTesta, preloadConfig } from '@testa-soft/react';
import { usePathname } from 'next/navigation.js';
import { useEffect, useRef, useState } from 'react';
import { readClientCookie } from '../client-cookie.ts';
import { DEFAULT_TRACKING_HOST } from '../constants.ts';
import { applyAssignedExperiments, revealShield } from './apply-assignments.ts';
import { clientOwnsDecision } from './cold-decision.ts';
import { startGoalTracking } from './goal-tracking.ts';
import {
  PREVIEW_VARIATION_ID,
  fetchPreviewChanges,
  getPreviewToken,
  isPreviewRequested,
} from './preview.ts';

/**
 * Props of the INTERNAL client provider.
 *
 * @internal Most apps want `TestaProvider` from `@testa-soft/next/server`
 * instead — it takes `projectId`, fetches the config server-side, and renders
 * this component with the resolved `config`.
 */
export interface TestaProviderProps {
  /**
   * The same ProjectConfig the middleware uses (local fixture, or fetched
   * server-side by `/server`'s RSC). Optional: when the server couldn't resolve
   * one, the client fetches it itself from `projectId` — a config host the
   * SERVER can't reach must not mean no experiments at all.
   */
  config?: ProjectConfig;
  /** Project id for the client's own config fetch, when `config` is absent. */
  projectId?: string;
  /** Config host for that fetch. Defaults to the SDK's config host. */
  host?: string;
  /**
   * Backend base URL for preview mode (crobot) — where `/api/preview/{token}`
   * lives. Required for `?testa_preview` to fetch drafts; ignored otherwise.
   */
  previewApiUrl?: string;
  /**
   * Report exposures from the browser. Default true, and normally left alone:
   * the proxy counts visitors it can identify from the request and the browser
   * covers the rest, so between them each exposure is counted once. Set false
   * only when something else owns tracking entirely.
   */
  tracking?: boolean;
  /**
   * crobot base URL for goal conversions (`/api/leads/convert`) — same host the
   * middleware posts exposures to. Defaults to the SDK's tracking host.
   */
  trackingHost?: string;
  /** `Secure` on client-written cookies. Default true; false for local http dev. */
  secureCookies?: boolean;
  /**
   * Cookie `Domain` for client-written cookies. Pass the SAME value the proxy
   * uses (`cookieDomain` / `discoverRootDomain`) — a mismatch writes a
   * host-only cookie beside the proxy's domain-wide one, and the visitor can
   * end up with two assignments.
   */
  cookieDomain?: string;
  /**
   * TEMPORARY, for a site cutting over from the legacy crobot pixel while
   * experiments are LIVE: adopt a returning visitor's legacy 3.x cookies
   * (`_testa_exp_<id>`, `_testa_excl_<id>`, `_testa_ses_<id>`) into the packed
   * `_testa_exp` cookie before deciding anything.
   *
   * Pass the SAME value as the proxy's `legacyCookiesEnabled`. The client owns
   * every pageview the proxy passed through (a cold instance, `decisions:
   * 'client'`), so leaving it off here re-buckets exactly the visitors the
   * proxy would have carried over. See
   * `experiment-core/legacy-migration.ts` for what it reads and when it stops.
   */
  legacyCookiesEnabled?: boolean;
}

export function TestaProvider(props: TestaProviderProps): null {
  const { config: serverConfig, projectId, host, previewApiUrl, trackingHost } = props;
  const pathname = usePathname();
  // Only the FIRST cycle of a page load may redirect — see `allowRedirect`.
  // The effect re-runs per soft navigation; this ref does not.
  const firstCycle = useRef(true);

  // CONFIG, kicked off during FIRST RENDER (before effects) when the server
  // didn't resolve one. `preloadConfig` adopts the request `<TestaGuard
  // projectId>`'s head snippet already started and dedupes across mounts, so
  // this is never a second fetch.
  const [configPromise] = useState<Promise<ProjectConfig | null>>(() => {
    if (serverConfig) return Promise.resolve(serverConfig);
    if (!projectId) return Promise.resolve(null);
    return preloadConfig({ projectId, ...(host ? { host } : {}) });
  });

  // `pathname` is intentionally a dependency: it's the re-apply trigger on
  // App-Router soft navigation, even though it isn't read in the effect body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the re-run trigger
  useEffect(() => {
    let cancelled = false;
    let teardowns: Teardown[] = [];
    const dispose = () => {
      cancelled = true;
      for (const teardown of teardowns) {
        try {
          teardown();
        } catch {
          // never let a teardown break unmount / the next cycle
        }
      }
    };

    const search = typeof window !== 'undefined' ? window.location.search : '';

    if (isPreviewRequested(search)) {
      // Preview: skip assignment, fetch + apply drafts. Best-effort.
      const token = getPreviewToken(search);
      if (token && previewApiUrl) {
        void fetchPreviewChanges(previewApiUrl, token).then((changes) => {
          if (!cancelled && changes.length > 0) {
            teardowns.push(...applyVariation(PREVIEW_VARIATION_ID, changes));
          }
          revealShield();
        });
      } else {
        revealShield();
      }
      return dispose;
    }

    // Fail open on ANY throw in here (bad config shape, a DOM apply blowing up):
    // an experiment must never be able to leave the page shielded or crash the
    // host app's tree.
    void (async () => {
      const config = await configPromise;
      // No config anywhere (server couldn't fetch it, and neither could we):
      // fail open — reveal, so a config outage never leaves a page hidden.
      if (!config) {
        revealShield();
        return;
      }
      if (cancelled) return;

      const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
      const assignmentCookie = readClientCookie(ASSIGNMENT_COOKIE);

      // COLD FALLBACK — nothing decided this pageview, so we do: bucket, write
      // the assignment, redirect if the variant is a split-URL one, apply the
      // DOM, emit the exposure. Delegated whole to the client engine rather
      // than reimplemented here.
      if (
        clientOwnsDecision({
          config,
          cookieValue: assignmentCookie,
          currentUrl,
          hasServerConfig: !!serverConfig,
          getCookie: readClientCookie,
          ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
        })
      ) {
        const allowRedirect = firstCycle.current;
        firstCycle.current = false;
        const result = await runClientCycle(config, props, currentUrl, allowRedirect);
        if (cancelled) {
          for (const teardown of result.teardowns) teardown();
          return;
        }
        // A redirect is in flight: leave the shield UP, the page is leaving.
        if (result.redirected) return;
        teardowns = result.teardowns;
        revealShield();
        return;
      }

      // Normal: apply the assigned variant, cookie-first — but only on pages that
      // match the experiment's page rule (keyed on `pathname` so a soft nav to a
      // non-matching route tears the change down instead of leaking it everywhere)
      // AND only when no exclusion rule matches this pageview (3.3.3
      // `handleExclusions` parity — mutual `experiment` exclusions included).
      // NOTE: no `country` here — a server-fetched config's geo is the
      // datacenter's; geo exclusions are the middleware's job per request.
      teardowns.push(
        ...applyAssignedExperiments(config, assignmentCookie, currentUrl, {
          url: currentUrl,
          getCookie: readClientCookie,
          ...(typeof navigator !== 'undefined' ? { userAgent: navigator.userAgent } : {}),
        }),
      );
      revealShield();

      // Fire the client events for every experiment the visitor is exposed to on
      // this page (split-URL, DOM, and control alike) — once per load, deduped in
      // the bus. This is the client event surface + the GTM dataLayer push.
      //
      // BOTH events fire here, in order. The proxy already bucketed this visitor
      // server-side, so `variation_assigned` is a MIRROR of that decision — the
      // client's first sight of it — not a second bucketing. Without it a
      // browser-side listener sees `variation_assigned` only on the pageviews
      // the proxy did not decide (a cold instance, `decisions: 'client'`), which
      // is the sparser and less representative half of the traffic. The
      // authoritative pre-redirect assignment signal remains the proxy's
      // `onVariationAssigned` hook: on a split-URL variant this page IS the
      // destination, so by the time it runs the 307 has already happened.
      installTestaGlobal();
      const uuid = readClientCookie(UUID_COOKIE) ?? '';
      const nowSec = Math.floor(Date.now() / 1000);
      for (const e of resolveExposures(config, assignmentCookie, currentUrl, nowSec)) {
        if (config.project_id == null) continue;
        const payload = {
          project_id: config.project_id,
          experiment: e.experimentId,
          variation: e.variationId,
          uuid,
          ...(e.title ? { title: e.title } : {}),
          url: currentUrl,
        };
        emitVariationAssigned(payload);
        emitVariationApplied(payload);
        // COUNT HERE too — the proxy counts at assignment, and crobot dedups on
        // `(experiment_id, uuid)` so the overlap collapses. The browser is the only
        // place the visitor id can be recovered once a cookie stops sticking
        // (the store falls back to its storage mirror), so on cookie-hostile
        // traffic this reports ONE visitor where the server would report one
        // per pageview. Re-posting is harmless: crobot dedups on
        // `(experiment_id, uuid)`, which is what makes emitting on every load
        // — the 3.3.3 pixel's model — safe.
        if (props.tracking !== false) {
          void emitExposure(trackingHost ?? DEFAULT_TRACKING_HOST, payload);
        }
      }

      // Arm goal tracking (page_view / click / custom) for every assigned,
      // session-live experiment — NOT page-gated: a goal usually completes on a
      // different page than the experiment runs on. Conversions POST the legacy
      // `/api/leads/convert` payload; teardown re-arms cleanly on soft nav.
      teardowns.push(
        startGoalTracking(
          config,
          assignmentCookie,
          currentUrl,
          uuid,
          trackingHost ?? DEFAULT_TRACKING_HOST,
          nowSec,
        ),
      );
    })().catch(() => {
      revealShield();
    });

    return dispose;
    // Keyed on `config.config_hash` (a stable string), NOT the `config` object —
    // so a caller passing an inline config, a dev Fast Refresh, or a parent
    // re-render doesn't re-run the effect and stack duplicate inserts. Re-runs
    // only on a real config change or route change (pathname).
  }, [serverConfig?.config_hash, projectId, pathname, previewApiUrl, trackingHost]);

  return null;
}

/**
 * The cold-fallback cycle: the same client engine the Pages Router and pure-SPA
 * surfaces run, so a pageview the server didn't decide behaves identically to
 * one it did — same deterministic bucketing, same cookie, same events.
 */
function runClientCycle(
  config: ProjectConfig,
  props: TestaProviderProps,
  currentUrl: string,
  allowRedirect: boolean,
): Promise<{ teardowns: Teardown[]; redirected: boolean }> {
  const store = new DocumentCookieStore({
    secure: props.secureCookies ?? true,
    ...(props.cookieDomain ? { domain: props.cookieDomain } : {}),
  });
  return initTesta({
    config,
    currentUrl,
    store,
    // A soft-nav URL is assembled by the app and may still be incomplete; an
    // initial-load URL came over the wire. Only the second is safe to commit an
    // irreversible navigation against. Matches the Pages Router policy.
    allowRedirect,
    allowAssign: allowRedirect,
    ...(props.previewApiUrl ? { previewApiUrl: props.previewApiUrl } : {}),
    ...(props.tracking !== undefined ? { tracking: props.tracking } : {}),
    ...(props.trackingHost ? { trackingHost: props.trackingHost } : {}),
    ...(props.legacyCookiesEnabled ? { legacyCookiesEnabled: true } : {}),
  }).then((result) => ({ teardowns: result.teardowns, redirected: result.redirected }));
}

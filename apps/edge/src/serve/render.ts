import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * Build the JS body the customer's browser receives from `GET /projects/:slug.js`.
 *
 * For `4.0` projects: emits a small `cfPrefill` IIFE before the loader+runtime
 * bundle. The bundle reads `window.cfPrefill.project` to know which experiments
 * to evaluate without hitting the network again.
 *
 * For frozen legacy bundles (`3.4`, `3.6`): returns the bundle verbatim.
 * Those bundles include their own bootstrap and read `window.crbData` set by
 * customer-side embedding code.
 */
export function renderPixel(config: ProjectConfig, bundle: string, environment: string): string {
  if (config.integration_version !== '4.0') {
    return bundle;
  }
  return [
    '(function(){',
    '  window.cfPrefill = window.cfPrefill || {};',
    `  window.cfPrefill.project = ${safeJson(config)};`,
    `  window.cfPrefill.env = ${safeJson(environment)};`,
    '})();',
    bundle,
  ].join('\n');
}

/**
 * JSON.stringify with HTML-comment-safe escaping. The output is embedded in
 * a `<script>` tag context, so any `</script>` substring inside the JSON
 * would let an attacker break out. Replace the literal slash before `script`
 * with its escaped form. Same protection for `<!--` HTML-comment open.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

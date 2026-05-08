/**
 * Build-time tracker version. Stamped into every PixelEvent for diagnostics.
 *
 * For now this is a hand-edited constant; the bundle build can override it
 * via esbuild's `define` in CI when cutting a release.
 */
export const TRACKER_VERSION = '4.0.0';

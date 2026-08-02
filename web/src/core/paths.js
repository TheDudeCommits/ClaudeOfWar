/**
 * Runtime asset URLs.
 *
 * Vite rewrites the paths it can see at build time, but every asset here is
 * fetched from a string built at runtime, so those are invisible to it. On
 * GitHub Pages the site is served from a project subpath (/ClaudeOfWar/), where
 * a leading-slash URL resolves to the domain root and 404s. Route every runtime
 * asset URL through this.
 */
const BASE = import.meta.env.BASE_URL || '/';

export function asset(p) {
  return BASE.replace(/\/$/, '/') + String(p).replace(/^\//, '');
}

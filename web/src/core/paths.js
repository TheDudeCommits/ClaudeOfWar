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
  const s = String(p);
  // Idempotent: several modules resolve a directory once and then resolve the
  // full file path again, which would otherwise yield /base/base/... and 404.
  if (BASE !== '/' && s.startsWith(BASE)) return s;
  if (/^(https?:)?\/\//.test(s)) return s;
  return BASE.replace(/\/?$/, '/') + s.replace(/^\//, '');
}

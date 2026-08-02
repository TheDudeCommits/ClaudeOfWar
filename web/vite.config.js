// Served from a GitHub Pages project subpath, so the bundle needs a base. All
// runtime asset URLs go through src/core/paths.js, which reads BASE_URL.
export default {
  base: process.env.COW_BASE || '/',
  build: { chunkSizeWarningLimit: 1500 },
};

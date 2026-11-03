import { defineConfig, loadEnv, type Plugin } from 'vite';

// Multi-page static build: index.html (the paper) and catalog.html (the searchable catalog).
// Paths are relative to the project root (where vite is run).
//
// Social cards: the pages carry %SITE_URL% in og:image and twitter:image. Social crawlers need an absolute URL, so at build time the placeholder becomes
// VITE_SITE_URL (no trailing slash; read from the environment or a .env file). Unset, it becomes the empty string and the tags keep the relative "/og.png".
// `npm run check:dist` fails when the placeholder is left behind, and, with VITE_SITE_URL set, when the cards are not absolute.
function siteUrlPlugin(siteUrl: string): Plugin {
  return {
    name: 'site-url',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl),
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const siteUrl = (env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '');
  if (siteUrl && !/^https?:\/\/[^/\s]+/i.test(siteUrl)) throw new Error(`VITE_SITE_URL must be an absolute http(s) URL, got "${siteUrl}"`);
  return {
    plugins: [siteUrlPlugin(siteUrl)],
    build: {
      chunkSizeWarningLimit: 700, // three.js lives in the lazily loaded globe chunk
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: 'index.html',
          catalog: 'catalog.html',
        },
      },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});

// Checks the built pages' social cards. Fails when the %SITE_URL% placeholder is left in dist/index.html or dist/catalog.html.
// With VITE_SITE_URL set (the deploy case) it also fails unless og:image and twitter:image are absolute URLs under that site.
// Without it the cards keep the relative "/og.png" (fine for a local build, not for sharing) and the script says so.
//   VITE_SITE_URL=https://example.org npm run build && npm run check:dist
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const site = (process.env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '');
let bad = 0;
for (const f of ['index.html', 'catalog.html']) {
  const p = join(dist, f);
  if (!existsSync(p)) { console.error(`check-dist: ${p} is missing (run npm run build first)`); bad++; continue; }
  const html = readFileSync(p, 'utf8');
  if (html.includes('%SITE_URL%')) { console.error(`check-dist: ${f} still contains %SITE_URL% (build with vite, not a copy of the source page)`); bad++; }
  const want = `${site}/og.png`;
  for (const tag of [/<meta property="og:image" content="([^"]*)"/, /<meta name="twitter:image" content="([^"]*)"/]) {
    const m = tag.exec(html);
    if (!m) { console.error(`check-dist: ${f} has no ${tag.source.slice(0, 30)} tag`); bad++; continue; }
    if (m[1] !== want) { console.error(`check-dist: ${f}: ${m[1]} but expected ${want}`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(site ? `check-dist: og:image and twitter:image are ${site}/og.png in both pages` : 'check-dist: no placeholder left; VITE_SITE_URL is not set, so og:image and twitter:image stay the relative /og.png');

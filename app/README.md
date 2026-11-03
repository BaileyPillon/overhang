# Overhang app

The site: a globe console (first screen), the evidence matrix, the paper, and the searchable catalog. Vite and TypeScript, three.js for the globe, KaTeX for the equations. It is a static build with two pages, `index.html` (everything but the catalog) and `catalog.html`. All numbers come from the JSON files in `public/data/`, which are fetched at run time from `/data/*.json`; nothing is typed into the pages.

Design target: [`../design/TARGET.md`](../design/TARGET.md). Data contract: [`../design/DATA.md`](../design/DATA.md).

## Dev

```bash
cd app
npm ci
npm run dev          # http://localhost:5173 (hot reload)
npm run typecheck    # tsc --noEmit
```

Deep links work in dev and in the build: `#OV-15` selects a hole, `#T-video-001` tracks a report, `#OV-15&T-video-001` does both. With no hash the globe opens on the default story: OV-15 selected, a smart-TV hack from the video tracked, the picked concept's marker pinned to the limb. `?layers=prior,live,-concepts` presets layers and `?cam=lat,lon[,zoom]` sets the camera.

## Build

```bash
npm run build        # type-check, then the static site in dist/
npm run preview      # serve dist/ at http://localhost:4173
npm run check:dist   # social-card tags are right (see below)
```

**Social cards.** `og:image` and `twitter:image` need absolute URLs for crawlers. The pages carry a `%SITE_URL%` placeholder, and the build replaces it with `VITE_SITE_URL` (no trailing slash, from the environment or a `.env` file). Unset, the tags keep the relative `/og.png`, which is fine locally and not for sharing.

```bash
VITE_SITE_URL=https://your.site npm run build && VITE_SITE_URL=https://your.site npm run check:dist
```

PowerShell: `$env:VITE_SITE_URL = 'https://your.site'; npm run build; npm run check:dist`.

## Deploy (Vercel)

[`vercel.json`](vercel.json) is all the configuration: `npm ci`, `npm run build`, serve `dist/` (both pages, clean URLs, so `/catalog` serves `catalog.html`).

- `/assets/*` (Vite's hashed files): `public, max-age=31536000, immutable`.
- `/data/*` (the JSON, the live index, the land texture): `public, max-age=0, must-revalidate`, so a data update is picked up on the next load and unchanged files cost a 304.
- Everything else uses Vercel's default, which revalidates.

```bash
npm i -g vercel                         # once
vercel link                             # once, from app/
vercel env add VITE_SITE_URL production # the production URL, no trailing slash
vercel deploy --prod
```

Set the project's root directory to `app` if you deploy from the repository instead of from this folder. Any static host works the same way: build with `VITE_SITE_URL`, publish `dist/`, and send the two cache rules above.

## Data

The files in `public/data/` are written by the scripts in `../scripts/` (`export_app_data.py`, `globe_data.py`, `finalize_app_data.py`, `bh_family_readings.py`) and by Drift's export; rebuild them in the order given in the [repository README](../README.md#the-app). The app loads them through `src/data.ts`.

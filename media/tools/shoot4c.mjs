// LIVE loaded state (needs network: Hacker News Algolia + the 33 MB model). usage: node shoot4c.mjs [base] [outdir]
import { launch, sleep, setup, shot } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = process.argv[3] || '../../design/shots/build-4';
const c = await launch(9341);
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('overhang-live-ok','1')}catch(e){}` });
await setup(c, { w: 1600, h: 1000, dark: true, url: BASE + '/#OV-15' });
await sleep(7000);
const before = await c.evaluate(`JSON.stringify({alt: window.__globe.cam.base*window.__globe.cam.zoom})`);
await c.evaluate(`window.__globe.live(true)`);
for (let i = 0; i < 20; i++) {
  await sleep(4000);
  const st = await c.evaluate(`JSON.stringify({stat: document.querySelector('.gl-lv-stat')?.textContent, cards: document.querySelectorAll('.gl-lv-card').length, compact: document.querySelector('.gl-live')?.classList.contains('compact'), h: document.querySelector('.gl-live')?.getBoundingClientRect().height, msg: document.querySelector('.gl-lv-msg')?.textContent.slice(0, 80)})`);
  console.log(i, st);
  if (i === 1) await shot(c, `${OUT}/live-loading-strip.png`);
  if (JSON.parse(st).cards > 0) break;
}
await sleep(6000);
await shot(c, `${OUT}/live-loaded.png`);
console.log(before, await c.evaluate(`JSON.stringify({alt: window.__globe.cam.base*window.__globe.cam.zoom})`));
await c.close(); process.exit(0);

import { launch, sleep, setup } from './cdp.mjs';
const c = await launch(9470);
await setup(c, { w: 390, h: 844, dpr: 1, mobile: true, dark: true, url: 'http://localhost:4173/#OV-15' });
await sleep(6000);
console.log(await c.evaluate(`JSON.stringify([...document.querySelectorAll('.gl-hl')].filter(e=>e.classList.contains('sel')||parseFloat(e.style.opacity)>0).map(e=>({cls:e.className, op:e.style.opacity, tr:e.style.transform, txt:e.textContent})))`));
console.log(await c.evaluate(`JSON.stringify({desk: matchMedia('(min-width: 1100px)').matches, trk: document.querySelector('.gl-trk')?.style.transform})`));
await c.close(); process.exit(0);

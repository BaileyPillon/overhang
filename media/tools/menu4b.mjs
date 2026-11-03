import { launch, sleep, setup } from './cdp.mjs';
const c = await launch(9347);
await setup(c, { w: 390, h: 844, dpr: 1, mobile: true, dark: true, url: 'http://localhost:5173/' });
await sleep(5000);
await c.evaluate(`document.getElementById('menu-btn').click()`); await sleep(300);
await c.evaluate(`document.querySelector('#sections-nav a[href="#matrix"]').click()`); await sleep(3000);
console.log(await c.evaluate(`JSON.stringify({y: scrollY, matrixTop: document.getElementById('matrix').getBoundingClientRect().top})`));
await c.close(); process.exit(0);

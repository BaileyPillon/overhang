import { launch, sleep, setup, shot } from './cdp.mjs';
const c = await launch();
await setup(c, { w: 1600, h: 1000, path: '/#OV-15', dark: true, url: 'http://localhost:5173/#OV-15' });
for (let i = 0; i < 8; i++) { await sleep(1500); console.log(i, await c.evaluate('scrollY + " " + document.activeElement.tagName + "." + document.activeElement.className')); }
await c.close(); process.exit(0);

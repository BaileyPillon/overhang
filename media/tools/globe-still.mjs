import { launch, sleep, setup, shot } from './cdp.mjs';
const c = await launch();
await setup(c, { w: 1600, h: 1000, url: (process.argv[2] || 'http://localhost:5188') + '/#OV-15' });
await sleep(9000);
await c.evaluate(`document.querySelector('canvas.gl-cv').blur(); document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
await shot(c, '../overhang-globe.png');
await c.close(); process.exit(0);

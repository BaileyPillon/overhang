import { launch, sleep, setup, shot, box } from './cdp.mjs';
const c = await launch();
await setup(c, { w: 1440, h: 900, url: 'http://localhost:4173/' });
await sleep(9000);
for (const [sel, f] of [['#matrix .figure.mx', 'matrix'], ['#fig4', 'rep']]) {
  await c.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
  await sleep(1500);
  const b = await box(c, sel);
  console.log(sel, JSON.stringify(b));
  const pad = 24;
  await shot(c, `../frames/probe-${f}.png`, { x: Math.max(0, b.x - pad), y: b.y - pad, width: Math.min(1440, b.width + 2 * pad), height: b.height + 2 * pad });
}
await c.close(); process.exit(0);

import { launch, sleep, setup, shot, box } from './cdp.mjs';
const OUT = '..';
const HIDE_BAR = `document.head.appendChild(Object.assign(document.createElement('style'),{textContent:'.topbar{display:none!important}'}))`;

// 1+2: console, dark, OV-15, concepts on; then thermal
{
  const c = await launch();
  await setup(c, { w: 1600, h: 1000, url: 'http://localhost:4173/#OV-15' });
  await sleep(9000);
  await c.evaluate(`document.querySelector('canvas.gl-cv').blur(); document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await shot(c, `${OUT}/overhang-globe.png`);
  await c.evaluate(`document.querySelector('#gl-seg button[data-m=thermal]').click()`);
  await sleep(3500);
  await shot(c, `${OUT}/overhang-thermal.png`);
  await c.close();
}
// 3+4: figures at 2x
{
  const c = await launch();
  await setup(c, { w: 1440, h: 900, dpr: 2, url: 'http://localhost:4173/' });
  await sleep(9000);
  await c.evaluate(HIDE_BAR);
  await c.evaluate(`window.dispatchEvent(new CustomEvent('overhang:select-hole',{detail:{code:'OV-15',source:'globe'}}))`);
  await sleep(1200);
  const pad = 20;
  let b = await box(c, '#matrix .figure.mx');
  let bb = await box(c, '#matrix .mx-body');
  await c.evaluate(`document.querySelector('#matrix .figure.mx').scrollIntoView({block:'start'})`);
  await sleep(1500);
  b = await box(c, '#matrix .figure.mx'); bb = await box(c, '#matrix .mx-body');
  await shot(c, `${OUT}/overhang-matrix.png`, { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: bb.y + bb.height - b.y + 2 * pad });
  await c.evaluate(`document.querySelector('#fig4').scrollIntoView({block:'start'})`);
  await sleep(1500);
  b = await box(c, '#fig4');
  await shot(c, `${OUT}/overhang-replication.png`, { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });
  await c.close();
}
// 5: mobile hero
{
  const c = await launch();
  await setup(c, { w: 390, h: 844, dpr: 2, mobile: true, url: 'http://localhost:4173/' });
  await sleep(9000);
  await shot(c, `${OUT}/overhang-mobile.png`);
  await c.close();
}
process.exit(0);

import { launch, sleep, setup, shot, box } from './cdp.mjs';
const c = await launch();
await setup(c, { w: 1440, h: 900, dpr: 2, url: 'http://localhost:4173/' });
await sleep(9000);
await c.evaluate(`document.head.appendChild(Object.assign(document.createElement('style'),{textContent:'.topbar{display:none!important}'}))`);
const code = process.argv[2] || '';
if (code) { await c.evaluate(`window.dispatchEvent(new CustomEvent('overhang:select-hole',{detail:{code:'${code}',source:'globe'}}))`); await sleep(1200); }
await c.evaluate(`document.querySelector('#matrix .figure.mx').scrollIntoView({block:'start'})`);
await sleep(1500);
const pad = 20, b = await box(c, '#matrix .figure.mx'), bb = await box(c, '#matrix .mx-body');
console.log(JSON.stringify(b), JSON.stringify(bb));
await shot(c, '../overhang-matrix.png', { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: bb.y + bb.height - b.y + pad - 8 });
await c.close(); process.exit(0);

// Final shots for the review pass: console (first screen), built section, matrix, mobile. usage: node shoot-final.mjs [base] [outdir] [which,...]
// which = console-dark, console-paper, built-dark, built-paper, matrix-dark, matrix-paper, mobile-dark, mobile-paper, matrix-390, ... (default: the six required)
import { launch, sleep, setup, shot, box } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:5188';
const OUT = process.argv[3] || '../../design/shots/final';
mkdirSync(OUT, { recursive: true });
const WHICH = (process.argv[4] || 'console-dark,console-paper,built-dark,built-paper,matrix-dark,mobile-dark').split(',');
let port = 9800 + (process.pid % 90);
const errors = [];
for (const key of WHICH) {
  const [kind, theme] = key.split('-');
  const dark = theme !== 'paper';
  const w = theme === '390' ? 390 : kind === 'mobile' ? 390 : 1440;
  const h = w === 390 ? 844 : 900;
  const c = await launch(port++);
  c.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(key + ' EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(key + ' ERR ' + m.params.args.map((a) => a.value || a.description).join(' '));
  });
  await setup(c, { w, h, dark, mobile: w === 390, dpr: 1, url: BASE + '/' });
  await sleep(9000);
  await c.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  if (kind === 'console' || kind === 'mobile') {
    await shot(c, `${OUT}/${key}.png`);
  } else if (kind === 'built') {
    for (let i = 0; i < 60; i++) { if (await c.evaluate(`!!document.querySelector('#fig8 .bt-svg') && !!document.querySelector('#fig6 .bt-svg')`).catch(() => false)) break; await sleep(500); }
    await sleep(1500);
    const b = await box(c, '#built');
    await shot(c, `${OUT}/${key}.png`, { x: 0, y: b.y, width: w, height: Math.min(b.height, 9500) });
  } else if (kind === 'matrix') {
    await c.evaluate(`document.querySelector('#matrix .figure.mx').scrollIntoView({block:'start'})`);
    await sleep(1800);
    const b = await box(c, '#matrix .figure.mx');
    await shot(c, `${OUT}/${key}.png`, { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(w, b.width + 16), height: b.height + 16 });
  }
  console.log(key, await c.evaluate(`JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`));
  await c.close();
}
console.log('errors:', JSON.stringify(errors.filter((e) => !/GPU stall|swiftshader/i.test(e)).slice(0, 8)));
process.exit(0);

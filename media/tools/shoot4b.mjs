// build-4 extra shots: layers, LIVE consent strip, keyboard focus, motion toggle. usage: node shoot4b.mjs [base] [outdir]
import { launch, sleep, setup, shot } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = process.argv[3] || '../../design/shots/build-4';
async function run(name, o, fn) {
  const c = await launch(9340);
  const logs = [];
  c.on((d) => { if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ')); });
  await setup(c, { ...o, url: BASE + (o.path || '/') });
  await sleep(o.wait || 7000);
  await fn(c);
  console.log(name, logs.filter((l) => !/GPU stall|swiftshader/i.test(l)).slice(0, 5).join(' | ') || 'no console errors');
  await c.close();
}
await run('layers', { w: 1600, h: 1000, path: '/?layers=prior,pooled,newrep#OV-15', dark: true }, async (c) => { await shot(c, `${OUT}/layers-prior-pooled-new.png`); });
await run('live-ask', { w: 1600, h: 1000, path: '/#OV-15', dark: true }, async (c) => {
  await c.evaluate(`window.__globe.live(true)`); await sleep(2500); await shot(c, `${OUT}/live-consent.png`);
  console.log(await c.evaluate(`JSON.stringify({ask: !!document.querySelector('.gl-lv-msg.ask'), h: document.querySelector('.gl-live')?.getBoundingClientRect().height, canvas: document.querySelector('.gl-stage canvas').getBoundingClientRect().height})`));
});
await run('kbd', { w: 1600, h: 1000, path: '/#OV-15', dark: true }, async (c) => {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  console.log(await c.evaluate(`document.activeElement.className + ' | ' + document.activeElement.textContent.slice(0,30)`));
  await c.evaluate(`document.querySelector('.theme-toggle button[data-theme-choice=light]').focus()`);
  await sleep(300);
  await shot(c, `${OUT}/focus-theme-toggle.png`, { x: 1300, y: 0, width: 300, height: 60 });
  await c.evaluate(`document.querySelector('canvas.gl-cv').focus()`);
  await sleep(400);
  await shot(c, `${OUT}/focus-canvas.png`);
});
await run('motion', { w: 1600, h: 1000, path: '/#OV-15', dark: true }, async (c) => {
  await c.evaluate(`document.getElementById('gl-mot').click()`); await sleep(500);
  console.log(await c.evaluate(`JSON.stringify({attr: document.documentElement.hasAttribute('data-motion-off'), txt: document.getElementById('gl-mot').textContent, ls: localStorage.getItem('overhang-motion')})`));
});
process.exit(0);

// build-4 screenshots + checks. usage: node shoot4.mjs [base] [outdir]
import { launch, sleep, setup, shot, box } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = process.argv[3] || '../../design/shots/build-4';
const only = process.argv[4] || '';
const errs = [];
let portN = 9400 + (process.pid % 90);
async function run(name, o, fn) {
  if (only && !only.split(',').includes(name)) return;
  const c = await launch(portN++);
  const logs = [];
  c.on((d) => { if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ')); });
  await setup(c, { ...o, url: BASE + (o.path || '/') });
  await sleep(o.wait || 7000);
  await c.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await fn(c);
  const ov = await c.evaluate(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
  console.log(name, JSON.stringify(ov), logs.filter(l=>!/GPU stall|swiftshader/i.test(l)).slice(0,6).join(' | ') || 'no console errors');
  await c.close();
}
await run('desktop-dark', { w: 1600, h: 1000, path: '/#OV-15', dark: true }, async (c) => { await shot(c, `${OUT}/desktop-dark.png`); await c.evaluate(`document.querySelector('#gl-seg button[data-m=thermal]').click()`); await sleep(3000); await shot(c, `${OUT}/desktop-thermal.png`); });
await run('desktop-paper', { w: 1600, h: 1000, path: '/#OV-15', dark: false }, async (c) => { await shot(c, `${OUT}/desktop-paper.png`); });
await run('small-1100', { w: 1100, h: 700, path: '/#OV-15', dark: true }, async (c) => { await shot(c, `${OUT}/desktop-1100x700.png`); });
await run('small-1366', { w: 1366, h: 768, path: '/#OV-15', dark: true }, async (c) => { await shot(c, `${OUT}/desktop-1366x768.png`); });
await run('matrix', { w: 1440, h: 900, path: '/', dark: true }, async (c) => {
  await c.evaluate(`document.querySelector('#matrix').scrollIntoView({block:'start'})`); await sleep(1500); await shot(c, `${OUT}/matrix-dark.png`);
});
await run('built', { w: 1440, h: 900, path: '/', dark: true }, async (c) => {
  await c.evaluate(`document.querySelector('#built').scrollIntoView({block:'start'})`); await sleep(1500); await shot(c, `${OUT}/built-current.png`);
});
// the placeholder state: winner.json answered as {"status":"pending"} (the real file is owned by the Drift build and is not touched)
if (!only || only.split(',').includes('built-placeholder')) {
  const c = await launch(portN++);
  c.on(async (d) => {
    if (d.method === 'Fetch.requestPaused') {
      await c.send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"status":"pending"}').toString('base64') });
    }
  });
  await c.send('Fetch.enable', { patterns: [{ urlPattern: '*winner.json*', requestStage: 'Request' }] });
  await setup(c, { w: 1440, h: 900, dark: true, url: BASE + '/' });
  await sleep(6000);
  await c.evaluate(`document.querySelector('#built').scrollIntoView({block:'start'})`); await sleep(1500);
  await shot(c, `${OUT}/built-placeholder.png`);
  console.log('built-placeholder', await c.evaluate(`document.querySelector('#built').innerText.slice(0,160).split(String.fromCharCode(10)).join(' | ')`));
  await c.close();
}
await run('transition', { w: 1440, h: 900, path: '/', dark: true }, async (c) => {
  await c.evaluate(`scrollTo(0, document.querySelector('#plate').getBoundingClientRect().bottom + scrollY - 600)`); await sleep(1500); await shot(c, `${OUT}/transition.png`);
});
await run('mobile', { w: 390, h: 844, dpr: 2, mobile: true, path: '/', dark: true }, async (c) => {
  await shot(c, `${OUT}/mobile-dark.png`);
  await c.evaluate(`scrollTo(0,500)`); await sleep(800); await shot(c, `${OUT}/mobile-dark-2.png`);
});
process.exit(0);

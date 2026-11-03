// build-4 interaction smoke test: every layer, every sensor, hole and contact selection, keyboard, drag; reports exceptions. usage: node interact4.mjs [base]
import { launch, sleep, setup, shot } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5173';
for (const [w, h, mobile] of [[1600, 1000, false], [390, 844, true]]) {
  const c = await launch(9344);
  const errs = [];
  c.on((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error')) errs.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ')); });
  await setup(c, { w, h, mobile, dark: false, url: BASE + '/' });
  await sleep(6500);
  const keys = ['1', '2', '3', '4', '1', 'h', 'h', 'n', 'n', 'N'];
  for (const k of keys) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k, windowsVirtualKeyCode: k.charCodeAt(0) });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: k.charCodeAt(0) });
    await sleep(250);
  }
  await c.evaluate(`document.querySelectorAll('.gl-layer').forEach((b) => b.click())`); await sleep(600);
  await c.evaluate(`document.querySelectorAll('.gl-layer').forEach((b) => b.click())`); await sleep(600);
  await c.evaluate(`[...document.querySelectorAll('#gl-cat .gl-c')].slice(0, 19).forEach((b, i) => setTimeout(() => b.click(), i * 120))`); await sleep(3500);
  await c.evaluate(`document.querySelector('[data-act=more]')?.click(); document.querySelector('[data-act=nn-all]')?.click()`); await sleep(400);
  await c.evaluate(`document.querySelector('[data-theme-choice=dark]').click()`); await sleep(800);
  await c.evaluate(`document.querySelector('[data-theme-choice=light]').click()`); await sleep(800);
  await c.evaluate(`window.__globe.mode('thermal')`); await sleep(1500);
  if (!mobile) await shot(c, `../../design/shots/build-4/desktop-thermal.png`);
  await c.evaluate(`window.__globe.mode('normal')`); await sleep(500);
  console.log(w + 'x' + h, errs.filter((l) => !/GPU stall|swiftshader/i.test(l)).slice(0, 5).join(' | ') || 'no exceptions');
  await c.close();
}
process.exit(0);

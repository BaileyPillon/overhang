import { launch, sleep, setup } from './cdp.mjs';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
const FR = '../frames/gif';
rmSync(FR, { recursive: true, force: true }); mkdirSync(FR, { recursive: true });
const c = await launch();
await setup(c, { w: 1600, h: 1000, url: 'http://localhost:4173/' });
await sleep(9000);
const mouse = (type, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const key = (k) => c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k, code: 'Digit' + k, windowsVirtualKeyCode: k.charCodeAt(0) }).then(() => c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Digit' + k, windowsVirtualKeyCode: k.charCodeAt(0) }));
let n = 0; const times = [];
const grab = async () => {
  const r = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  writeFileSync(`${FR}/f${String(n++).padStart(4, '0')}.jpg`, Buffer.from(r.data, 'base64')); times.push(Date.now());
};
// start a slow drag on an empty bit of the globe stage
let x = 560; const y = 330, DX = 2.6;
await mouse('mousePressed', x, y); await mouse('mouseMoved', x + 1, y);
const t0 = Date.now();
const spin = async () => { x += DX; await mouse('mouseMoved', x, y); };
// phase 1: rotate, normal (36 frames)
for (let i = 0; i < 36; i++) { await spin(); await grab(); }
// phase 2: sensors while still turning
for (const k of ['2', '3', '4']) {
  await key(k);
  for (let i = 0; i < 12; i++) { await spin(); await grab(); }
}
await mouse('mouseReleased', x, y);
// phase 3: back to normal, select a hole from the catalog
await key('1');
for (let i = 0; i < 4; i++) await grab();
const bx = await c.evaluate(`(()=>{const b=[...document.querySelectorAll('#gl-cat .gl-c')].find(e=>/OV15|OV-15/.test(e.textContent)||e.getAttribute('title')?.startsWith('OV-15'));const r=b.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx[0], y: bx[1] });
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx[0], y: bx[1], button: 'left', buttons: 1, clickCount: 1 });
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx[0], y: bx[1], button: 'left', buttons: 0, clickCount: 1 });
for (let i = 0; i < 28; i++) await grab();
console.log('frames', n, 'secs', (Date.now() - t0) / 1000, 'fps', n / ((Date.now() - t0) / 1000));
writeFileSync(`${FR}/times.json`, JSON.stringify(times));
await c.close(); process.exit(0);

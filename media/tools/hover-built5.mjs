// Hover test for the #built charts: moves the mouse over one mark per chart and prints the tooltip text.
import { launch, sleep, setup, shot } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5188';
const OUT = process.argv[3] || '../../design/shots/build-5';
const c = await launch(9540 + Math.floor(Math.random() * 20));
await setup(c, { w: 1440, h: 900, dark: true, dpr: 1, url: BASE + '/' });
for (let i = 0; i < 60; i++) { if (await c.evaluate(`!!document.querySelector('#fig8 .bt-svg')`).catch(() => false)) break; await sleep(500); }
await sleep(500);
const sels = ['#fig5 .bt-band', '#fig5 .bt-pg', '#fig6 [data-bt="count"] .bt-lane', '#fig6 [data-bt="shifts"] g[data-bt-tip]', '#fig7 .bt-lane', '#fig8 [data-bt="hrforest"] g[data-bt-tip]', '#fig8 [data-bt="hrbars"] g[data-bt-tip]'];
for (const sel of sels) {
  const pos = await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;document.documentElement.style.scrollBehavior='auto';e.scrollIntoView({block:'center'});const r=(e.querySelector('rect,circle,path')||e).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if (!pos) { console.log(sel, 'not found'); continue; }
  await sleep(500);
  const p2 = await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});const r=(e.querySelector('rect,circle,path')||e).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y });
  await sleep(250);
  const t = await c.evaluate(`(()=>{const t=document.querySelector('.tip');return t&&t.classList.contains('on')?t.innerText.split(String.fromCharCode(10)).join(' | '):'(no tip)'})()`);
  console.log(sel, '=>', t);
  if (sel.includes('shifts')) await shot(c, `${OUT}/hover-fig6b.png`);
}
await c.close(); process.exit(0);

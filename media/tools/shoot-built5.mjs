// Screenshots of the #built section (Drift's results): dark and paper, 1440 and mobile 390.
// usage: node shoot-built5.mjs [base] [outdir] [which]    which = comma list of dark1440,paper1440,dark390,paper390 (default all)
import { launch, sleep, setup, shot, box } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5188';
const OUT = process.argv[3] || '../../design/shots/build-5';
const WHICH = (process.argv[4] || 'dark1440,paper1440,dark390,paper390').split(',');
const IDS = ['fig5', 'fig6', 'fig7', 'fig8', 'memo-card', 'bt-credits', 'bt-globe-note'];
const c = await launch(9460 + Math.floor(Math.random() * 30));
const errors = [];
c.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
});
const cfgs = {
  dark1440: { w: 1440, h: 900, dark: true, mobile: false },
  paper1440: { w: 1440, h: 900, dark: false, mobile: false },
  dark390: { w: 390, h: 844, dark: true, mobile: true },
  paper390: { w: 390, h: 844, dark: false, mobile: true },
  dark768: { w: 768, h: 1024, dark: true, mobile: false },
  dark1100: { w: 1100, h: 800, dark: true, mobile: false },
  paper1100: { w: 1100, h: 800, dark: false, mobile: false },
  dark1000: { w: 1000, h: 800, dark: true, mobile: false },
  dark620: { w: 620, h: 900, dark: true, mobile: false },
};
for (const key of WHICH) {
  const cfg = cfgs[key];
  await setup(c, { ...cfg, dpr: 1, url: BASE + '/' });
  // wait for the section to be drawn
  for (let i = 0; i < 60; i++) {
    const ok = await c.evaluate(`!!document.querySelector('#fig8 .bt-svg') && !!document.querySelector('#fig6 .bt-svg')`).catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  await sleep(1500);
  await c.evaluate(`document.fonts.ready.then(()=>true)`);
  await sleep(500);
  const b = await box(c, '#built');
  if (!b) { console.log(key, 'no #built'); continue; }
  // Chrome tiles wrap past about 8k px: take the section in 3500 px chunks
  for (let k = 0, y = 0; y < b.height; k++, y += 3500) await shot(c, `${OUT}/${key}-section-${k + 1}.png`, { x: 0, y: b.y + y, width: cfg.w, height: Math.min(3500, b.height - y) });
  for (const id of IDS) {
    const bb = await box(c, '#' + id);
    if (bb) await shot(c, `${OUT}/${key}-${id}.png`, { x: Math.max(0, bb.x - 8), y: Math.max(0, bb.y - 8), width: Math.min(cfg.w, bb.width + 16), height: Math.min(bb.height + 16, 9000) });
  }
  const sw = await c.evaluate(`JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mode: document.querySelector('.bt-tlwrap')?.dataset.mode})`);
  console.log(key, sw, 'section height', Math.round(b.height));
}
console.log('errors:', JSON.stringify(errors.slice(0, 8)));
await c.close(); process.exit(0);

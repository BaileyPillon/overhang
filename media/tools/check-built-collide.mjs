// Collision and overflow check for the #built charts: text boxes that overlap, text outside its svg, page-level horizontal scroll.
// usage: node check-built-collide.mjs [base] [widths comma list]
import { launch, sleep, setup } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5188';
const WIDTHS = (process.argv[3] || '1440,1100,900,768,600,390,360').split(',').map(Number);
const c = await launch(9500 + Math.floor(Math.random() * 30));
const expr = `(() => {
  const out = [];
  document.querySelectorAll('#built .bt-svg').forEach((svg, si) => {
    const id = svg.closest('figure')?.id + '/' + (svg.closest('.bt-chart')?.dataset.bt || 'tl');
    const sr = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim()).map(t => ({ t: t.textContent.trim().slice(0, 40), r: t.getBoundingClientRect() }));
    texts.forEach((a, i) => {
      if (a.r.left < sr.left - 1 || a.r.right > sr.right + 1) out.push(id + ' OUTSIDE ' + a.t + ' ' + Math.round(a.r.left - sr.left) + '..' + Math.round(a.r.right - sr.left) + ' of ' + Math.round(sr.width));
      for (let j = i + 1; j < texts.length; j++) {
        const b = texts[j];
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 1.5 && h > 2.5) out.push(id + ' OVERLAP "' + a.t + '" x "' + b.t + '" ' + Math.round(w) + 'x' + Math.round(h));
      }
    });
  });
  const de = document.documentElement;
  const wide = [...document.querySelectorAll('#built *')].filter(e => e.getBoundingClientRect().right > de.clientWidth + 1 && !e.closest('.scroll-x') && !e.closest('pre') && !e.closest('svg')).slice(0, 5).map(e => e.tagName + '.' + e.className + ' right=' + Math.round(e.getBoundingClientRect().right));
  return JSON.stringify({ scrollW: de.scrollWidth, clientW: de.clientWidth, issues: out, wide });
})()`;
for (const w of WIDTHS) {
  await setup(c, { w, h: 900, dark: true, mobile: w < 700, dpr: 1, url: BASE + '/' });
  for (let i = 0; i < 60; i++) {
    if (await c.evaluate(`!!document.querySelector('#fig8 .bt-svg') && !!document.querySelector('#fig6 .bt-svg')`).catch(() => false)) break;
    await sleep(500);
  }
  await sleep(1500);
  console.log(w, await c.evaluate(expr));
}
await c.close(); process.exit(0);

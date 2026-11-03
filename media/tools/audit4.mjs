// build-4 audit: horizontal overflow at several widths, small tap targets at 390, console errors. usage: node audit4.mjs [base]
import { launch, sleep, setup } from './cdp.mjs';
const BASE = process.argv[2] || 'http://localhost:5173';
for (const [w, h, mobile] of [[1260, 800, false], [1920, 1080, false]]) {
  const c = await launch(9342);
  const errs = [];
  c.on((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' ')); });
  await setup(c, { w, h, dpr: 1, mobile, dark: true, url: BASE + '/#OV-15' });
  await sleep(6500);
  const r = await c.evaluate(`(() => {
    const out = { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, small: [] };
    if (innerWidth <= 700) {
      document.querySelectorAll('a, button, [role=button], input, select, [tabindex="0"]').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return;
        if (e.closest('.sr') || e.classList.contains('sr')) return;
        if (r.height < 36 || r.width < 36) out.small.push((e.closest('[id]')?.id || '') + '>' + (e.className || e.tagName).toString().slice(0,24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      });
    }
    return out;
  })()`);
  console.log(w + 'x' + h, JSON.stringify({ sw: r.sw, cw: r.cw }), 'small:', r.small.length, [...new Set(r.small.map((x) => x.replace(/ [0-9]+x[0-9]+$/, '')))].join(' | '), '| errors:', errs.filter((l) => !/GPU stall|swiftshader/i.test(l)).slice(0, 3).join(' | ') || 'none');
  await c.close();
}
process.exit(0);

import { launch, sleep, setup } from './cdp.mjs';
const c = await launch(9345);
await setup(c, { w: 1440, h: 900, dark: true, url: (process.argv[2] || 'http://localhost:5173') + '/' });
await sleep(6000);
const t = await c.evaluate(`(() => { const g = (id) => document.getElementById(id)?.innerText || ''; return JSON.stringify({ abs: g('abstract').slice(0, 2600), repl: g('replication').slice(0, 3200), lim: g('methods').slice(0, 900) }); })()`);
const o = JSON.parse(t);
console.log(o.abs, '\n-----\n', o.repl, '\n-----\n', o.lim);
await c.close(); process.exit(0);

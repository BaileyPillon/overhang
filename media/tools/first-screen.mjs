// First-screen shots at chosen viewport sizes: node first-screen.mjs [base] [outdir] [name=WxH[:light][@hash] ...]
// e.g. node first-screen.mjs http://localhost:5188 ../../design/shots/final/_work/f "d1440=1440x900" "p1100=1100x800:light"
import { launch, sleep, setup, shot } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:5188';
const OUT = process.argv[3] || '../../design/shots/final/_work/f';
mkdirSync(OUT, { recursive: true });
let port = 9600 + (process.pid % 90);
for (const a of process.argv.slice(4)) {
  const [name, spec] = a.split('=');
  const m = /^(\d+)x(\d+)(:light)?(?:@(.*))?$/.exec(spec);
  const [w, h, light, hash] = [+m[1], +m[2], !!m[3], m[4] || ''];
  const c = await launch(port++);
  const logs = [];
  c.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((x) => x.value || x.description).join(' '));
  });
  await setup(c, { w, h, dark: !light, mobile: w < 600, url: BASE + '/' + (hash ? '#' + hash : '') });
  await sleep(9000);
  await c.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  await shot(c, `${OUT}/${name}.png`);
  const sw = await c.evaluate(`JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`);
  console.log(name, sw, logs.filter((l) => !/GPU stall|swiftshader/i.test(l)).slice(0, 5).join(' | ') || 'no console errors');
  await c.close();
}
process.exit(0);

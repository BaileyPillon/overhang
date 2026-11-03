// default-view check: screenshots the first screen at a few URLs and prints the console errors.
// usage: node defaultview.mjs [base] [outdir] [name=path ...]      e.g. node defaultview.mjs http://localhost:5173 ../../design/shots/default-view "cur=/#T-video-001&OV-15"
import { launch, sleep, setup, shot } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:5173';
const OUT = process.argv[3] || '../../design/shots/default-view';
mkdirSync(OUT, { recursive: true });
const jobs = process.argv.slice(4).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
if (!jobs.length) jobs.push(['default', '/']);
let port = 9500 + (process.pid % 90);
for (const [name, path] of jobs) {
  const c = await launch(port++);
  const logs = [];
  c.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('ERR ' + d.params.args.map((a) => a.value || a.description).join(' '));
  });
  const dark = !/light/.test(name);
  await setup(c, { w: 1600, h: 1000, dark, url: BASE + path });
  await sleep(8000);
  await c.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  await shot(c, `${OUT}/${name}.png`);
  console.log(name, path, logs.filter((l) => !/GPU stall|swiftshader/i.test(l)).slice(0, 5).join(' | ') || 'no console errors');
  await c.close();
}
process.exit(0);

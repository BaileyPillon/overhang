import { launch, sleep, shot } from './cdp.mjs';
const c = await launch();
await c.send('Emulation.setDeviceMetricsOverride', { width: 256, height: 256, deviceScaleFactor: 1, mobile: false });
await c.send('Page.navigate', { url: 'http://localhost:4173/favicon.svg' });
await sleep(1500);
await c.evaluate(`document.documentElement.style.cssText='width:256px;height:256px';document.documentElement.setAttribute('width','256');document.documentElement.setAttribute('height','256')`);
await shot(c, '../frames/fav.png'); await c.close(); process.exit(0);

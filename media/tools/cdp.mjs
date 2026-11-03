// Minimal Chrome DevTools Protocol helper (Node 22+ global WebSocket). No dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Chrome: set the CHROME env var to the browser executable, or put chrome / google-chrome / chromium on PATH.
// (Windows default install location: <Program Files>\Google\Chrome\Application\chrome.exe)
export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const names = ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean))
    for (const n of names) for (const e of exts) { const f = join(dir, n + e); if (existsSync(f)) return f; }
  throw new Error('Chrome not found: set the CHROME env var to the browser executable, or put chrome/chromium on PATH');
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(port = 9333 + Math.floor(Math.random() * 400)) {
  const dir = mkdtempSync(join(tmpdir(), 'ov-chrome-'));
  const proc = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  if (!ver) throw new Error('chrome did not start');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { const { res, rej } = pend.get(d.id); pend.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
    else listeners.forEach((l) => l(d));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  const on = (fn) => listeners.push(fn);
  const close = async () => { try { ws.close(); } catch {} if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill(); };
  return { send, evaluate, on, close };
}

import { writeFileSync } from 'node:fs';
export async function setup(c, { w, h, dpr = 1, mobile = false, dark = true, url }) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('overhang-theme','${dark ? 'dark' : 'light'}')}catch(e){}` });
  await c.send('Page.navigate', { url });
}
export async function shot(c, file, clip) {
  const p = { format: 'png', captureBeyondViewport: !!clip };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await c.send('Page.captureScreenshot', p);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
}
// bounding box of a selector in page (document) coordinates
export const box = (c, sel) => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}})()`);

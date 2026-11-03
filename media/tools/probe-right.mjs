import { launch, sleep, setup } from './cdp.mjs';
const [w,h]=[+process.argv[2],+process.argv[3]];
const c = await launch(9700+(process.pid%90));
await setup(c,{w,h,url:'http://localhost:5188/'}); await sleep(8000);
console.log(await c.evaluate(`JSON.stringify((()=>{const r=document.querySelector('.gl-right');const rr=r.getBoundingClientRect();return {rail:[rr.top,rr.bottom,r.scrollHeight,r.clientHeight], kids:[...r.children].map(k=>({c:k.className.slice(0,40),h:Math.round(k.getBoundingClientRect().height), inner:[...k.children].map(x=>x.className.slice(0,28)+':'+Math.round(x.getBoundingClientRect().height))}))}})())`));
await c.close(); process.exit(0);

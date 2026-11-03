// The globe console (G1 "Orbital Console", design/TARGET.md): the first screen.
//
// Every report is a point on a sphere (spherical UMAP of the embeddings, which is honest because normalized embeddings
// live on a hypersphere). Continents are dense clusters, oceans sparse regions. A hole is a ring at the midpoint of the
// two filaments it sits between: the reports carrying its row value and the reports carrying its column value. Hovering or
// selecting a hole lights those two filaments. Nothing here is computed on the picture; it only shows where things are.
//
// Layers, a tracked-contact panel, the hole catalog, sensor modes (and the printed negative for the paper theme) follow
// the approved mockup. The 2D plate in plate.ts is the fallback when WebGL is not available.
import './styles/globe.css';
import * as THREE from 'three';
import type { AppData, Hole, Point } from './data';
import { cellLabel } from './data';
import { esc, fmtE, fmtF, fmtN, fmtP, fmtQ } from './ui';
import { isLight } from './theme';

const D2R = Math.PI / 180;
const SELECT_EVENT = 'overhang:select-hole';

/* ------------------------------------------------------------------ data files */

interface GlobeFile {
  n: number;
  land: { threshold_8bit: number };
  points: { id: string; lat: number; lon: number; nn: [string, number][]; c: number; off: boolean }[];
  continents: { id: string; name: string | null; lat: number; lon: number; n: number; top: string[] }[];
  stats: { neighbour_overlap_globe_vs_full_at6?: number; domain_purity_at6?: { globe: number; full_space: number; chance: number } };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

function webglOK(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ model */

interface FamilyDef {
  id: string;
  name: string;
  dark: string;
  light: string;
  doms: string[];
}
const FAM: FamilyDef[] = [
  { id: 'machines', name: 'Machines', dark: '#FFD9A0', light: '#9A5E1E', doms: ['devices-home', 'software-dev', 'security-privacy'] },
  { id: 'commerce', name: 'Commerce & civic', dark: '#F4EFD8', light: '#6A5F2E', doms: ['money-business', 'work-productivity', 'civic-legal'] },
  { id: 'science', name: 'Science & learning', dark: '#D3E1F0', light: '#2A4A8C', doms: ['science-research', 'learning'] },
  { id: 'body', name: 'Body & home', dark: '#F2BCA6', light: '#A0482C', doms: ['health-body', 'family-kids', 'food-home-life', 'social-relationships'] },
  { id: 'play', name: 'Play & make', dark: '#D6E6AE', light: '#2F6B3A', doms: ['games', 'creative-media', 'travel-outdoors'] },
  { id: 'other', name: 'Other', dark: '#B9BCC2', light: '#5B6372', doms: ['other'] },
];
const FAM_OF = new Map<string, number>();
FAM.forEach((f, i) => f.doms.forEach((d) => FAM_OF.set(d, i)));

interface GP {
  i: number;
  id: string;
  p: Point;
  lat: number;
  lon: number;
  v3: THREE.Vector3;
  fam: number;
  mv: number;
  mt: number;
  nn: [number, number][];
  isNew: boolean;
  anchor: boolean;
}

type VerdictCode = 0 | 1 | 2 | 3;
interface GH {
  i: number;
  h: Hole;
  code: string;
  reg: boolean;
  v3: THREE.Vector3;
  lat: number;
  lon: number;
  rad: number;
  rv: THREE.Vector3;
  cv: THREE.Vector3;
  rowIdx: number[];
  colIdx: number[];
  sep: number;
  verdict: VerdictCode;
  E: number;
}

const llv = (lat: number, lon: number): THREE.Vector3 => {
  const la = lat * D2R;
  const lo = lon * D2R;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
};
const vlat = (v: THREE.Vector3): number => Math.asin(Math.max(-1, Math.min(1, v.y))) / D2R;
const vlon = (v: THREE.Vector3): number => Math.atan2(-v.z, v.x) / D2R;
const angDeg = (a: THREE.Vector3, b: THREE.Vector3): number => Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) / D2R;

function verdictCode(v: string | undefined | null): VerdictCode {
  const k = (v ?? '').toLowerCase();
  if (k === 'refuted') return 1;
  if (k === 'underpowered') return 2;
  if (k === 'replicated') return 3;
  return 0;
}

const hex3 = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

/** The printed negative: the dark render is mixed per channel between paper and ink, so a colour that should come out as D
 *  has to be fed to the dark render as n = (paper - D) / (paper - ink). */
const PAPER = hex3('#F5F7FA');
const NEG_INK = hex3('#0E1424');
function negOf(hex: string): THREE.Color {
  const d = hex3(hex);
  const c = [0, 1, 2].map((k) => Math.max(0, Math.min(1.6, ((PAPER[k] as number) - (d[k] as number)) / ((PAPER[k] as number) - (NEG_INK[k] as number)))));
  return new THREE.Color(c[0], c[1], c[2]);
}

type Mode = 'normal' | 'crt' | 'nvg' | 'thermal';
const MODE_NUM: Record<Mode, number> = { normal: 0, crt: 1, nvg: 2, thermal: 3 };

/* ------------------------------------------------------------------ shaders */

const globeVS = `
varying vec3 vObj; varying vec3 vView; varying vec3 vNv;
void main(){ vObj=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vView=mv.xyz; vNv=normalMatrix*normal; gl_Position=projectionMatrix*mv; }`;

const globeFS = (NH: number): string => `
precision highp float;
#define NH ${NH}
uniform sampler2D uLand; uniform vec2 uTexSize; uniform float uThr; uniform float uTime; uniform float uBump;
uniform vec4 uHC[NH]; uniform vec2 uHF[NH]; uniform float uSel; uniform float uRepl; uniform vec3 uAcc; uniform vec3 uInk; uniform vec3 uRef;
varying vec3 vObj; varying vec3 vView; varying vec3 vNv;
float Hs(vec2 uv){
  vec2 tc=uv*uTexSize-0.5; vec2 ip=floor(tc); vec2 f=tc-ip; vec2 f2=f*f; vec2 f3=f2*f;
  vec2 w0=(1.0-f)*(1.0-f)*(1.0-f)/6.0; vec2 w1=(4.0-6.0*f2+3.0*f3)/6.0; vec2 w2=(1.0+3.0*f+3.0*f2-3.0*f3)/6.0; vec2 w3=f3/6.0;
  vec2 g0=w0+w1, g1=w2+w3;
  vec2 o0=(ip-1.0+w1/g0+0.5)/uTexSize, o1=(ip+1.0+w3/g1+0.5)/uTexSize;
  float a=texture2D(uLand,vec2(o0.x,o0.y)).r, b=texture2D(uLand,vec2(o1.x,o0.y)).r;
  float c=texture2D(uLand,vec2(o0.x,o1.y)).r, d=texture2D(uLand,vec2(o1.x,o1.y)).r;
  return g0.y*(g0.x*a+g1.x*b)+g1.y*(g0.x*c+g1.x*d);
}
void main(){
  vec3 n=normalize(vObj);
  float lat=asin(clamp(n.y,-1.0,1.0)); float lon=atan(-n.z,n.x);
  vec2 uv=vec2(lon/6.2831853+0.5, 0.5-lat/3.14159265);
  float h=Hs(uv);
  float fwh=max(fwidth(h),1e-4);
  float land=smoothstep(uThr-fwh*1.1,uThr+fwh*1.1,h);
  float voidn=clamp((uThr-h)/(uThr-0.13),0.0,1.0);
  vec3 ocean=mix(vec3(0.012,0.020,0.030),vec3(0.030,0.085,0.105),voidn*voidn);
  float shore=smoothstep(uThr-0.16,uThr,h)*(1.0-land);
  ocean+=vec3(0.020,0.026,0.030)*shore;
  vec3 landc=mix(vec3(0.105,0.112,0.120),vec3(0.250,0.252,0.250),smoothstep(uThr,0.98,h));
  vec3 base=mix(ocean,landc,land);
  vec3 N0=normalize(vNv);
  vec3 dpx=dFdx(vView), dpy=dFdy(vView);
  vec3 r1=cross(dpy,N0), r2=cross(N0,dpx);
  float det=dot(dpx,r1);
  vec3 grad=sign(det)*(dFdx(h)*r1+dFdy(h)*r2)*uBump*(0.25+0.75*land);
  vec3 N=normalize(abs(det)*N0-grad);
  vec3 L=normalize(vec3(-0.55,0.62,0.62));
  float diff=max(dot(N,L),0.0);
  float flat_=max(dot(N0,L),0.0);
  float relief=(diff-flat_);
  vec3 col=base*(0.62+0.55*flat_)+vec3(0.55,0.57,0.58)*relief*0.42*land+vec3(0.05,0.07,0.08)*relief*0.10*(1.0-land);
  float x=(h-uThr)/0.10;
  float fwx=max(fwidth(x),1e-4);
  float g=abs(fract(x+0.5)-0.5)/fwx;
  float minor=(1.0-clamp(g*0.9,0.0,1.0))*smoothstep(0.25,0.6,abs(x));
  float coast=1.0-smoothstep(0.35,1.15,abs(h-uThr)/fwh);
  col+=uInk*(0.095*minor*land+0.020*minor*(1.0-land))*0.9;
  col+=uAcc*0.042*minor*(1.0-land)*voidn;
  col+=uInk*0.36*coast;
  vec2 ll=vec2(lon,lat)*57.29578/15.0;
  float fwl=fwidth(ll.x); float fwa=fwidth(ll.y);
  float gx=(fwl<0.5)?(1.0-clamp(abs(fract(ll.x+0.5)-0.5)/max(fwl,1e-4),0.0,1.0)):0.0;
  float gy=1.0-clamp(abs(fract(ll.y+0.5)-0.5)/max(fwa,1e-4),0.0,1.0);
  col+=uInk*0.040*max(gx,gy);
  vec3 hc=vec3(0.0);
  for(int i=0;i<NH;i++){
    float en=uHF[i].x;
    if(en<0.01) continue;
    vec3 c=uHC[i].xyz; float dd=dot(n,c);
    if(dd<0.55) continue;
    float ang=acos(clamp(dd,-1.0,1.0)); float r=uHC[i].w;
    float sel=(abs(float(i)-uSel)<0.5)?1.0:0.0;
    float fw=fwidth(ang)+1e-5;
    vec3 up=(abs(c.y)>0.95)?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0);
    vec3 t1=normalize(cross(up,c)); vec3 t2=cross(c,t1);
    float az=atan(dot(n,t2),dot(n,t1));
    float th=mix(0.0020,0.0036,sel);
    float rg=1.0-smoothstep(th,th+fw*1.1,abs(ang-r));
    float dn=mix(30.0,40.0,sel);
    float ph=fract(az/6.2831853*dn+uTime*mix(0.01,0.03,sel));
    float dash=smoothstep(0.0,0.08,ph)*(1.0-smoothstep(0.50,0.58,ph));
    float a=rg*dash*mix(0.55,1.0,sel);
    float r2b=r*0.52;
    float rg2=1.0-smoothstep(0.0011,0.0011+fw*1.1,abs(ang-r2b));
    float ph2=fract(az/6.2831853*24.0-uTime*0.02);
    a+=rg2*smoothstep(0.0,0.1,ph2)*(1.0-smoothstep(0.2,0.3,ph2))*0.5*sel;
    float fill=(1.0-smoothstep(r*0.55,r,ang))*mix(0.035,0.11,sel);
    float wrap=abs(fract(az/1.5707963+0.5)-0.5)*1.5707963*r;
    float tickA=(1.0-smoothstep(0.0012,0.0012+fw,wrap))*smoothstep(r*0.62,r*0.62+0.002,ang)*(1.0-smoothstep(r+0.012,r+0.016,ang))*sel;
    float sweep=pow(fract(az/6.2831853-uTime*0.07),7.0)*(1.0-smoothstep(r*0.96,r,ang))*0.22*sel;
    float on=a+fill+tickA*0.9+sweep;
    vec3 hcol=uAcc; float dim=1.0;
    if(uRepl>0.5){
      float vd=uHF[i].y;
      if(vd>0.5&&vd<1.5){ hcol=uRef; dim=0.85; } else if(vd>1.5&&vd<2.5){ dim=0.9; }
    }
    hc+=hcol*on*dim*en;
  }
  col+=hc*0.85;
  float fres=pow(1.0-max(dot(N0,normalize(-vView)),0.0),3.0);
  col+=vec3(0.10,0.14,0.17)*fres*0.55;
  gl_FragColor=vec4(col,1.0);
}`;

const atmoVS = `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`;
const atmoFS = `varying vec3 vN; varying vec3 vP; uniform vec3 uC; void main(){ float d=dot(vN,normalize(-vP)); float x=clamp(-d/0.355,0.0,1.0); float i=pow(x,3.2)*0.55; gl_FragColor=vec4(uC*i,1.0);} `;

const ptsVS = `
attribute vec3 aCol; attribute float aSize; attribute float aVid; attribute float aKind; attribute float aNn; attribute float aMove; attribute float aMat; attribute float aPh; attribute float aNew;
uniform float uPx; uniform float uTime; uniform float uK; uniform float uTint; uniform float uVid; uniform vec3 uStar; uniform vec3 uAcc; uniform vec3 uInk;
uniform float uHoleSel; uniform float uUseMove; uniform float uUseMat; uniform float uTrkMove; uniform float uTrkMat; uniform float uDim; uniform float uNewOn;
varying vec3 vCol; varying float vVid; varying float vI; varying float vKind; varying float vMk; varying float vNn;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  float tw=0.93+0.07*sin(uTime*1.4+aPh*6.2831);
  float s=aSize; vec3 base=mix(uStar,aCol,uTint);
  float kind=aKind; float bright=1.0;
  if(kind>0.5&&kind<1.5){ base=uAcc; s*=1.7; bright=1.5; }
  else if(kind>1.5&&kind<2.5){ base=uInk; s*=1.55; bright=1.4; }
  else if(kind>2.5){ base=uStar*1.1; s*=1.7; bright=1.8; }
  else {
    if(uHoleSel>0.5){ bright=uDim; }
    if(uNewOn>0.5){ if(aNew>0.5){ base=mix(base,uAcc,0.5); bright*=1.5; s*=1.15; } else { bright*=0.5; } }
  }
  float vid=aVid*uVid; s*=1.0+vid*1.15; bright*=1.0+vid*0.55;
  if(aNn>0.5){ s*=1.25; bright*=1.25; }
  float mk=0.0;
  if(uUseMove>0.5&&abs(aMove-uTrkMove)<0.5) mk=1.0;
  if(uUseMat>0.5&&abs(aMat-uTrkMat)<0.5) mk=max(mk,2.0);
  if(mk>0.5) s=max(s,13.0);
  float facing=dot(normalize(position),normalize(cameraPosition));
  float fade=smoothstep(0.02,0.22,facing);
  gl_PointSize=s*uPx*(uK/-mv.z)*tw;
  vCol=base; vVid=vid; vI=bright*fade; vKind=kind; vMk=mk; vNn=aNn;
}`;
const ptsFS = `
precision highp float;
varying vec3 vCol; varying float vVid; varying float vI; varying float vKind; varying float vMk; varying float vNn;
void main(){
  vec2 p=gl_PointCoord*2.0-1.0; float r=length(p);
  if(r>1.0||vI<0.01) discard;
  float core=exp(-r*r*26.0);
  float halo=pow(max(1.0-r,0.0),2.8);
  float I=core*1.35+halo*0.5;
  vec3 col=vCol*I;
  if(vVid>0.01){
    float fl=exp(-abs(p.x)*22.0)*exp(-abs(p.y)*2.4)+exp(-abs(p.y)*22.0)*exp(-abs(p.x)*2.4);
    col+=vCol*fl*0.95*vVid;
    col+=mix(vCol,vec3(1.0),0.5)*core*0.35*vVid;
  }
  if(vKind>2.5){ float rg=1.0-smoothstep(0.0,0.05,abs(r-0.78)); col+=vCol*rg*0.7; }
  if(vMk>0.5){
    float m=(vMk<1.5)? (1.0-smoothstep(0.0,0.06,abs(r-0.82))) : (1.0-smoothstep(0.0,0.06,max(abs(p.x),abs(p.y))*1.0-0.7)*(1.0-smoothstep(0.62,0.7,max(abs(p.x),abs(p.y)))))*step(0.62,max(abs(p.x),abs(p.y)));
    col+=vec3(0.55)*m*0.75;
  }
  gl_FragColor=vec4(col*vI,1.0);
}`;

const postVS = 'varying vec2 vUv; void main(){vUv=uv; gl_Position=vec4(position.xy,0.0,1.0);}';
const postFS = `
precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uMode; uniform float uTime; uniform vec2 uRes;
float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
vec3 ramp(float t){
  vec3 a=vec3(0.0,0.0,0.0), b=vec3(0.30,0.03,0.01), c=vec3(0.82,0.22,0.02), d=vec3(1.0,0.72,0.12), e=vec3(1.0,0.98,0.86);
  if(t<0.25) return mix(a,b,t/0.25); if(t<0.5) return mix(b,c,(t-0.25)/0.25); if(t<0.75) return mix(c,d,(t-0.5)/0.25); return mix(d,e,(t-0.75)/0.25);
}
void main(){
  vec2 uv=vUv; vec2 cc=uv-0.5; float asp=uRes.x/uRes.y;
  vec3 c; vec2 px=1.0/uRes;
  if(uMode<1.5){
    float r2=dot(cc,cc); uv=0.5+cc*(1.0+0.05*r2);
    c=vec3(texture2D(tDiffuse,uv+vec2(px.x*1.5,0.0)).r, texture2D(tDiffuse,uv).g, texture2D(tDiffuse,uv-vec2(px.x*1.5,0.0)).b);
    vec3 bl=(texture2D(tDiffuse,uv+px*vec2(3.0,0.0)).rgb+texture2D(tDiffuse,uv-px*vec2(3.0,0.0)).rgb+texture2D(tDiffuse,uv+px*vec2(0.0,3.0)).rgb+texture2D(tDiffuse,uv-px*vec2(0.0,3.0)).rgb)*0.25;
    c+=bl*0.45;
    float scan=0.80+0.20*sin(uv.y*uRes.y*3.14159);
    float mask=0.92+0.08*sin(uv.x*uRes.x*2.0944);
    c*=scan*mask*vec3(1.04,1.0,0.90);
    c*=1.0-0.55*smoothstep(0.30,0.75,length(cc));
    c*=0.97+0.03*sin(uTime*60.0);
    if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) c=vec3(0.0);
  } else if(uMode<2.5){
    vec3 s=texture2D(tDiffuse,uv).rgb;
    vec3 bl=(texture2D(tDiffuse,uv+px*vec2(4.0,0.0)).rgb+texture2D(tDiffuse,uv-px*vec2(4.0,0.0)).rgb+texture2D(tDiffuse,uv+px*vec2(0.0,4.0)).rgb+texture2D(tDiffuse,uv-px*vec2(0.0,4.0)).rgb)*0.25;
    float l=dot(s+bl*0.8,vec3(0.30,0.59,0.11)); l=pow(clamp(l*2.4,0.0,1.6),0.72);
    float nz=hash(uv*uRes+fract(uTime)*91.7)-0.5; l+=nz*0.16*(0.4+l);
    l*=0.88+0.12*sin(uv.y*uRes.y*3.14159);
    float v=smoothstep(0.98,0.42,length(cc*vec2(asp,1.0))); l*=v;
    c=vec3(0.10,1.0,0.32)*l;
    c+=vec3(0.55,0.7,0.55)*max(l-0.85,0.0);
  } else if(uMode<3.5){
    vec3 s=texture2D(tDiffuse,uv).rgb;
    vec3 bl=(texture2D(tDiffuse,uv+px*vec2(5.0,0.0)).rgb+texture2D(tDiffuse,uv-px*vec2(5.0,0.0)).rgb+texture2D(tDiffuse,uv+px*vec2(0.0,5.0)).rgb+texture2D(tDiffuse,uv-px*vec2(0.0,5.0)).rgb)*0.25;
    float l=dot(s*0.7+bl*0.7,vec3(0.30,0.59,0.11)); l=clamp(pow(l*1.45,0.85),0.0,1.0);
    l+=(hash(uv*uRes+fract(uTime)*17.0)-0.5)*0.025;
    c=ramp(clamp(l,0.0,1.0));
  } else {
    /* the printed negative: ink on cool paper */
    vec3 s=clamp(texture2D(tDiffuse,uv).rgb,0.0,1.0);
    c=mix(vec3(0.9608,0.9686,0.9804),vec3(0.0549,0.0784,0.1412),s);
  }
  gl_FragColor=vec4(c,1.0);
}`;

/* ------------------------------------------------------------------ helpers for the panels */

function srcLabel(url: string): { html: string; t: string | null } {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '');
    const v = u.searchParams.get('v');
    const t = u.searchParams.get('t');
    let path = (u.pathname + (v ? `?v=${v}` : '')).replace(/^\//, '');
    let archived = '';
    if (/^reddit\./.test(host) && !/(^|\.)reddit\.com$/.test(host)) {
      archived = ' (archived copy)';
      path = path.replace(/\/snapshots\/.*$/, '');
    }
    if (path.length > 34) path = `${path.slice(0, 33)}…`;
    return { html: `${esc(host)}/${esc(path)}${archived}`, t };
  } catch {
    return { html: esc(url), t: null };
  }
}

const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : '#');

const contName = (c: { name: string | null; top: string[] }): string => (c.name ?? (c.top[0] ?? '').replace(/-/g, ' / ')).split(' - ')[0] as string;

/* ------------------------------------------------------------------ the console */

export async function initGlobe(el: HTMLElement, data: AppData): Promise<boolean> {
  if (!webglOK()) return false;
  let G: GlobeFile;
  let landImg: HTMLImageElement;
  try {
    const base = import.meta.env.BASE_URL;
    const [gres, img] = await Promise.all([fetch(`${base}data/globe.json`), loadImage(`${base}data/land.png`)]);
    if (!gres.ok) return false;
    G = (await gres.json()) as GlobeFile;
    landImg = img;
  } catch {
    return false;
  }
  try {
    return run(el, data, G, landImg);
  } catch (err) {
    console.error('globe failed, falling back to the plate', err);
    el.innerHTML = '';
    el.className = '';
    return false;
  }
}

function run(el: HTMLElement, data: AppData, G: GlobeFile, landImg: HTMLImageElement): boolean {
  const { meta, holes } = data;
  const appById = new Map(data.points.map((p) => [p.id, p]));
  const nR1 = meta.N_r1;

  /* ------------------------------------------------ points */
  const P: GP[] = [];
  const byId = new Map<string, GP>();
  const moves: string[] = [];
  const mats: string[] = [];
  G.points.forEach((g) => {
    const p = appById.get(g.id);
    if (!p) return;
    const mv = p.mv ?? '';
    const mt = p.mt ?? '';
    if (!moves.includes(mv)) moves.push(mv);
    if (!mats.includes(mt)) mats.push(mt);
    const gp: GP = {
      i: P.length, id: g.id, p, lat: g.lat, lon: g.lon, v3: llv(g.lat, g.lon), fam: FAM_OF.get(p.d) ?? 5,
      mv: moves.indexOf(mv), mt: mats.indexOf(mt), nn: [], isNew: false, anchor: g.id.startsWith('anchors-'),
    };
    P.push(gp);
    byId.set(g.id, gp);
  });
  const idxInData = new Map(data.points.map((p, i) => [p.id, i]));
  P.forEach((gp) => {
    gp.isNew = (idxInData.get(gp.id) ?? 0) >= nR1;
  });
  G.points.forEach((g) => {
    const gp = byId.get(g.id);
    if (!gp) return;
    gp.nn = g.nn.map(([id, d]) => [byId.get(id)?.i ?? -1, d] as [number, number]).filter(([i]) => i >= 0);
  });
  const NP = P.length;
  const nVideo = P.filter((p) => p.p.v).length;
  const nNew = P.filter((p) => p.isNew).length;

  /* ------------------------------------------------ holes (positions derived from the filaments, as in the exporter) */
  const H: GH[] = holes.map((h, i) => {
    const rowIdx = h.row_ids.map((id) => byId.get(id)?.i ?? -1).filter((k) => k >= 0);
    const colIdx = h.col_ids.map((id) => byId.get(id)?.i ?? -1).filter((k) => k >= 0);
    const cen = (idx: number[]): THREE.Vector3 => {
      const s = new THREE.Vector3();
      idx.forEach((k) => s.add((P[k] as GP).v3));
      return s.lengthSq() < 1e-9 ? new THREE.Vector3(1, 0, 0) : s.normalize();
    };
    const rv = cen(rowIdx);
    const cv = cen(colIdx);
    const mid = rv.clone().add(cv);
    const v3 = mid.length() < 1e-3 ? rv.clone() : mid.normalize();
    const E = h.registered?.E ?? h.E;
    return {
      i, h, code: h.code, reg: h.prereg, v3, lat: vlat(v3), lon: vlon(v3), rad: Math.min(22, 3.6 + 1.55 * E) * D2R, rv, cv, rowIdx, colIdx,
      sep: angDeg(rv, cv), verdict: verdictCode(h.replication?.verdict), E,
    };
  });
  const NH = H.length;
  const nReg = H.filter((h) => h.reg).length;
  const nPooled = NH - nReg;
  const holeByCode = new Map(H.map((h) => [h.code, h]));

  /* ------------------------------------------------ DOM */
  const ytTitle = meta.video.title;
  el.className = 'gl';
  el.setAttribute('aria-label', `Globe: ${fmtN(NP)} reports as points on a sphere and the holes between them`);
  const kMin = Math.min(...Object.values(meta.kappa.r1), ...(meta.kappa.grow ? Object.values(meta.kappa.grow) : [1]));
  const rep = data.replication;
  const nRefuted = rep.rows.filter((r) => r.verdict === 'refuted').length;
  const nUnder = rep.rows.filter((r) => r.verdict === 'underpowered').length;
  const nRepl = rep.rows.filter((r) => r.verdict === 'replicated').length;
  const nPrior = holes.filter((h) => h.prior_art).length;

  el.innerHTML = `
    <div class="gl-stage">
      <canvas class="gl-cv" tabindex="0" role="application" aria-roledescription="interactive globe" aria-label="Globe of ${fmtN(NP)} reports. Drag or use the arrow keys to turn it, scroll or plus and minus to zoom, H for the next hole. The hole catalog and the nearest-contact list work without it."></canvas>
      <div class="gl-grid"></div><div class="gl-vig"></div>
      <svg class="gl-ret" aria-hidden="true" focusable="false"></svg>
      <div class="gl-labels" aria-hidden="true"></div>
      <div class="gl-fx"></div>
    </div>
    <i class="gl-vc tl"></i><i class="gl-vc tr"></i><i class="gl-vc bl"></i><i class="gl-vc br"></i>
    <header class="gl-top">
      <div class="gl-cls"><span class="bar">PRE-REGISTERED // TESTED ON NEW REPORTS</span></div>
      <div class="gl-brand"><h1>${esc(fmtN(NP))} things people have done with Claude, and <em>the holes between them.</em></h1></div>
      <div class="gl-meta"><a class="gl-cta" href="#abstract">Read the evidence <span aria-hidden="true">&darr;</span></a></div>
    </header>
    <aside class="gl-panel gl-brk gl-left" aria-label="Layers">
      <div class="gl-hd"><b>Layers</b><span class="sp"></span><span class="m">L1</span></div>
      <div id="gl-layers" style="margin-top:8px"></div>
      <div class="gl-sect"><div class="gl-hd"><b>Domain families</b><span class="sp"></span></div><div class="gl-key" id="gl-key" style="margin-top:6px"></div></div>
      <div class="gl-sect gl-conts-sect"><div class="gl-hd"><b>Continents</b><span class="sp"></span><span class="m">REPORTS</span></div><div class="gl-key gl-conts" id="gl-conts" style="margin-top:6px"></div></div>
      <div class="gl-mapwrap">
        <div class="gl-hd" style="margin-bottom:6px"><b>Plate</b><span class="sp"></span><span class="m">EQUIRECT</span></div>
        <canvas class="gl-map" id="gl-map" width="480" height="240" role="img" aria-label="Flat map of the same reports, the rings and the current view"></canvas>
        <div class="gl-legend2"><span><i style="background:rgba(var(--g-ink-rgb),.5)"></i>land = dense</span><span><i style="border:1px solid var(--g-acc);border-radius:50%"></i>hole</span><span><i style="border:1px solid var(--g-star)"></i>view</span></div>
      </div>
    </aside>
    <aside class="gl-right" aria-label="Selection">
      <section class="gl-panel gl-brk gl-contact" id="gl-contact" aria-live="polite"></section>
      <section class="gl-panel gl-brk2 gl-holec" id="gl-holec" aria-live="polite"></section>
      <section class="gl-panel gl-brk2 gl-cat" id="gl-cat"></section>
    </aside>
    <p class="gl-foot" id="gl-foot"></p>
    <footer class="gl-bottom">
      <div class="gl-tel">
        <div><small>CAM LAT</small><b id="gl-tlat">+00.0&deg;</b></div>
        <div><small>CAM LON</small><b id="gl-tlon">+000.0&deg;</b></div>
        <div class="opt"><small>ALT</small><b id="gl-talt">0.00 <span>R</span></b></div>
        <div><small>IN VIEW</small><b id="gl-tview">0 <span>/ ${NP}</span></b></div>
        <div><small>SAMPLE</small><b>${esc(fmtN(nR1))} <span>+</span> ${esc(fmtN(nNew))} <span>new</span></b></div>
        <div><small>TAGGERS &kappa;</small><b>&ge; ${esc(fmtF(kMin, 2))}</b></div>
        <div class="opt"><small>PREREG</small><b>${esc(meta.prereg_commit)}</b></div>
        <div class="opt"><small>PROJECTION</small><b>spherical UMAP <span>&middot; PCA-${esc(meta.pca)}</span></b></div>
      </div>
      <div class="gl-modes"><small>SENSOR</small>
        <div class="gl-seg" id="gl-seg" role="group" aria-label="Sensor mode">
          <button type="button" data-m="normal" aria-pressed="true"><kbd>1</kbd>Normal</button>
          <button type="button" data-m="crt" aria-pressed="false"><kbd>2</kbd>CRT</button>
          <button type="button" data-m="nvg" aria-pressed="false"><kbd>3</kbd>NVG</button>
          <button type="button" data-m="thermal" aria-pressed="false"><kbd>4</kbd>Thermal</button>
        </div>
      </div>
    </footer>`;

  const $ = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s) as T;
  const canvas = $<HTMLCanvasElement>('canvas.gl-cv');
  const stage = $<HTMLElement>('.gl-stage');
  const labelsEl = $<HTMLElement>('.gl-labels');
  const retEl = el.querySelector<SVGSVGElement>('svg.gl-ret') as SVGSVGElement;
  const leftEl = $<HTMLElement>('.gl-left');
  const rightEl = $<HTMLElement>('.gl-right');
  const topEl = $<HTMLElement>('.gl-top');
  const bottomEl = $<HTMLElement>('.gl-bottom');
  const layersEl = $<HTMLElement>('#gl-layers');
  const keyEl = $<HTMLElement>('#gl-key');
  const mapC = $<HTMLCanvasElement>('#gl-map');
  const mctx = mapC.getContext('2d') as CanvasRenderingContext2D;
  const foot = $<HTMLElement>('#gl-foot');

  /* ------------------------------------------------ state */
  const pick0 = (data.winner.status === 'pending' && data.winner.pick ? holeByCode.get(data.winner.pick.code) : undefined) ?? (H[0] as GH);
  const nearestVideo = (hole: GH): GP => {
    let best: GP | null = null;
    let bd = 1e9;
    P.forEach((p) => {
      if (!p.p.v) return;
      const d = angDeg(p.v3, hole.v3);
      if (d < bd) { bd = d; best = p; }
    });
    return best ?? (P[0] as GP);
  };
  const state = {
    track: nearestVideo(pick0),
    hole: pick0.i,
    hover: -1,
    mode: 'normal' as Mode,
    light: isLight(),
    layers: { domains: true, moves: false, materials: false, video: true, newrep: false, holes: true, pooled: false, repl: true },
  };
  type LayerKey = keyof typeof state.layers;

  /* ------------------------------------------------ static UI */
  const layerDefs: { k: LayerKey | 'prior'; name: string; ct: string; cls: string; tip: string }[] = [
    { k: 'domains', name: 'Domains', ct: String(FAM.length), cls: '', tip: 'Tint every report by its domain family' },
    { k: 'moves', name: 'Moves', ct: String(moves.length), cls: '', tip: 'Mark every report that shares the tracked contact’s move' },
    { k: 'materials', name: 'Materials', ct: String(mats.length), cls: '', tip: 'Mark every report that shares the tracked contact’s material' },
    { k: 'video', name: 'Video', ct: String(nVideo), cls: '', tip: 'Reports flagged as from the one video' },
    { k: 'newrep', name: 'New sample', ct: fmtN(nNew), cls: '', tip: `The ${fmtN(nNew)} blind reports gathered after the holes were registered` },
    { k: 'holes', name: 'Holes', ct: String(nReg), cls: 'hole', tip: `The ${nReg} pre-registered holes` },
    { k: 'pooled', name: 'Pooled holes', ct: String(nPooled), cls: 'hole', tip: `${nPooled} more empty cells found after pooling, not pre-registered: exploratory` },
    { k: 'repl', name: 'Replication', ct: `${nRefuted}/${nUnder}/${nRepl}`, cls: 'hole', tip: 'Colour the rings by verdict: refuted / underpowered / replicated' },
    { k: 'prior', name: 'Prior art', ct: String(nPrior), cls: '', tip: 'Prior-art searches are in Table 2' },
  ];
  layerDefs.forEach((d) => {
    if (d.k === 'prior') {
      const a = document.createElement('a');
      a.className = 'gl-layer';
      a.href = '#built';
      a.title = d.tip;
      a.innerHTML = `<span class="bx" style="border-style:dashed"></span><span class="nm">${d.name}</span><span class="sub">TABLE 2</span><span class="ct">${d.ct}</span>`;
      layersEl.appendChild(a);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gl-layer ${d.cls}`;
    b.dataset.k = d.k;
    b.title = d.tip;
    b.setAttribute('aria-pressed', String(state.layers[d.k]));
    b.innerHTML = `<span class="bx"></span><span class="nm">${d.name}</span><span class="ct">${d.ct}</span>`;
    b.addEventListener('click', () => {
      state.layers[d.k as LayerKey] = !state.layers[d.k as LayerKey];
      b.setAttribute('aria-pressed', String(state.layers[d.k as LayerKey]));
      applyLayers();
      renderPanels();
    });
    layersEl.appendChild(b);
  });
  FAM.forEach((f, i) => {
    const n = P.filter((p) => p.fam === i).length;
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<span class="gl-sw" data-fam="${i}"></span><span class="nm">${esc(f.name)}</span><span class="ct">${n}</span>`;
    keyEl.appendChild(r);
  });
  $('#gl-conts').innerHTML = G.continents
    .filter((c) => c.n >= 60)
    .slice(0, 6)
    .map((c) => `<div class="row"><span class="id">${esc(c.id)}</span><span class="nm" title="${esc(c.name ?? '')}">${esc(contName(c))}</span><span class="ct">${c.n}</span></div>`)
    .join('');
  const overlap = G.stats.neighbour_overlap_globe_vs_full_at6;
  foot.innerHTML = `<b>Figure 1. Honest globe.</b> A spherical UMAP of unit embeddings: angles are projected${overlap != null ? `, ${Math.round(overlap * 100)}% of 6-nearest neighbours survive` : ''}. Land is dense, ocean sparse. A ring is the midpoint of two filaments, never empty space.`;

  /* ------------------------------------------------ three.js */
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  const cam = { lat: 41, lon: 32, zoom: 1, base: 5, anim: null as null | { t0: number; dur: number; lat0: number; lon0: number; lat1: number; dlon: number } };
  let W = 0;
  let Hh = 0;
  let PX = 1;
  let view = { cx: 0, cy: 0, x0: 0, x1: 0 };

  const camVec = (): THREE.Vector3 => llv(cam.lat, cam.lon);

  function measure(): void {
    const r = stage.getBoundingClientRect();
    W = Math.max(2, Math.round(r.width));
    Hh = Math.max(2, Math.round(r.height));
    const desktop = window.matchMedia('(min-width: 1100px)').matches;
    let x0 = 8;
    let x1 = W - 8;
    let y0 = 8;
    let y1 = Hh - 8;
    if (desktop) {
      const lr = leftEl.getBoundingClientRect();
      const rr = rightEl.getBoundingClientRect();
      const tr = topEl.getBoundingClientRect();
      const br = bottomEl.getBoundingClientRect();
      x0 = lr.right - r.left + 14;
      x1 = rr.left - r.left - 14;
      y0 = tr.bottom - r.top + 10;
      y1 = br.top - r.top - 4;
    }
    const fw = x1 - x0;
    const fh = y1 - y0;
    view = { cx: x0 + fw / 2, cy: y0 + fh / 2, x0, x1 };
    retEl.style.clipPath = desktop ? `inset(${Math.max(0, y0 - 4)}px 0 ${Math.max(0, Hh - y1 - 2)}px 0)` : '';
    const Rpx = Math.min(fw, fh) * 0.5 * (desktop ? 0.8 : 0.92);
    const sq = (Hh / 2) / (Math.tan(15 * D2R) * Rpx);
    cam.base = Math.sqrt(sq * sq + 1);
  }

  const gU: Record<string, THREE.IUniform> = {
    uLand: { value: null }, uTexSize: { value: new THREE.Vector2(360, 180) }, uThr: { value: G.land.threshold_8bit / 255 },
    uTime: { value: 0 }, uHC: { value: H.map((h) => new THREE.Vector4(h.v3.x, h.v3.y, h.v3.z, h.rad)) }, uHF: { value: H.map(() => new THREE.Vector2(1, 0)) },
    uSel: { value: state.hole }, uRepl: { value: 1 }, uAcc: { value: new THREE.Color('#8FD3E8') }, uInk: { value: new THREE.Color('#D6DCE3') },
    uRef: { value: new THREE.Color('#D98A6A') }, uBump: { value: 0.55 },
  };
  const pU: Record<string, THREE.IUniform> = {
    uPx: { value: 1 }, uTime: { value: 0 }, uK: { value: 5 }, uTint: { value: 1 }, uVid: { value: 1 }, uStar: { value: new THREE.Color('#FFE8BE') },
    uAcc: { value: new THREE.Color('#8FD3E8') }, uInk: { value: new THREE.Color('#E8ECF0') }, uHoleSel: { value: 1 }, uUseMove: { value: 0 }, uUseMat: { value: 0 },
    uTrkMove: { value: -1 }, uTrkMat: { value: -1 }, uDim: { value: 0.72 }, uNewOn: { value: 0 },
  };

  const globe = new THREE.Mesh(
    new THREE.SphereBufferGeometry(1, 128, 96),
    new THREE.ShaderMaterial({ uniforms: gU, vertexShader: globeVS, fragmentShader: globeFS(NH), extensions: { derivatives: true } }),
  );
  scene.add(globe);
  const atmo = new THREE.Mesh(
    new THREE.SphereBufferGeometry(1.07, 64, 48),
    new THREE.ShaderMaterial({ uniforms: { uC: { value: new THREE.Color(0.3, 0.4, 0.46) } }, vertexShader: atmoVS, fragmentShader: atmoFS, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
  );
  scene.add(atmo);

  const pos = new Float32Array(NP * 3);
  const aCol = new Float32Array(NP * 3);
  const aSize = new Float32Array(NP);
  const aVid = new Float32Array(NP);
  const aKind = new Float32Array(NP);
  const aNn = new Float32Array(NP);
  const aMove = new Float32Array(NP);
  const aMat = new Float32Array(NP);
  const aPh = new Float32Array(NP);
  const aNew = new Float32Array(NP);
  P.forEach((p, i) => {
    const v = p.v3;
    pos.set([v.x * 1.008, v.y * 1.008, v.z * 1.008], i * 3);
    aSize[i] = 9;
    aVid[i] = p.p.v ? 1 : 0;
    aMove[i] = p.mv;
    aMat[i] = p.mt;
    aNew[i] = p.isNew ? 1 : 0;
    aPh[i] = (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1;
  });
  const pg = new THREE.BufferGeometry();
  const colAttr = new THREE.BufferAttribute(aCol, 3);
  const kindAttr = new THREE.BufferAttribute(aKind, 1);
  const nnAttr = new THREE.BufferAttribute(aNn, 1);
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('aCol', colAttr);
  pg.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  pg.setAttribute('aVid', new THREE.BufferAttribute(aVid, 1));
  pg.setAttribute('aKind', kindAttr);
  pg.setAttribute('aNn', nnAttr);
  pg.setAttribute('aMove', new THREE.BufferAttribute(aMove, 1));
  pg.setAttribute('aMat', new THREE.BufferAttribute(aMat, 1));
  pg.setAttribute('aPh', new THREE.BufferAttribute(aPh, 1));
  pg.setAttribute('aNew', new THREE.BufferAttribute(aNew, 1));
  const pointsMat = new THREE.ShaderMaterial({ uniforms: pU, vertexShader: ptsVS, fragmentShader: ptsFS, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(pg, pointsMat);
  points.frustumCulled = false;
  scene.add(points);

  /* arcs */
  function arcPts(a: THREE.Vector3, b: THREE.Vector3, lift: number, seg: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const om = Math.acos(Math.min(1, a.dot(b)));
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const s = Math.sin(om);
      const v = om < 1e-4 ? a.clone() : a.clone().multiplyScalar(Math.sin((1 - t) * om) / s).add(b.clone().multiplyScalar(Math.sin(t * om) / s));
      v.normalize().multiplyScalar(1.009 + lift * Math.sin(Math.PI * t));
      out.push(v);
    }
    return out;
  }
  const arcGroup = new THREE.Group();
  scene.add(arcGroup);
  const arcMats: THREE.Material[] = [];
  function addArc(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, opacity: number, lift: number, dashed: boolean): void {
    const geo = new THREE.BufferGeometry().setFromPoints(arcPts(a, b, lift, 64));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.012, gapSize: 0.009, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const l = new THREE.Line(geo, mat);
    if (dashed) l.computeLineDistances();
    arcGroup.add(l);
    arcMats.push(mat);
  }
  let fanRow: THREE.LineSegments | null = null;
  let fanCol: THREE.LineSegments | null = null;
  function fanGeo(origin: THREE.Vector3, idx: number[]): THREE.BufferGeometry {
    const v: number[] = [];
    // at most 70 spokes per filament, the ones nearest the hole, so the fan stays a drawing and not a hairball
    const near = idx.slice().sort((x, y) => origin.dot((P[y] as GP).v3) - origin.dot((P[x] as GP).v3)).slice(0, 70);
    near.forEach((k) => {
      const q = P[k] as GP;
      const om = Math.acos(Math.min(1, origin.dot(q.v3)));
      const pts = arcPts(origin, q.v3, 0.05 * om, Math.max(8, Math.ceil(om / D2R / 3)));
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i] as THREE.Vector3;
        const b = pts[i + 1] as THREE.Vector3;
        v.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return g;
  }

  /* ------------------------------------------------ palette (dark, sensors, printed negative) */
  type Pal = { acc: string; ink: string; star: string; ref: string; fam: string[]; clear: number; neg: boolean };
  function palette(): Pal {
    if (state.mode === 'normal' && state.light) {
      return { acc: '#17708C', ink: '#15171C', star: '#8A500E', ref: '#B4532F', fam: FAM.map((f) => f.light), clear: 0x000000, neg: true };
    }
    const fam = FAM.map((f) => f.dark);
    const clear = state.mode === 'normal' ? 0x0a0f1c : 0x04060a;
    switch (state.mode) {
      case 'crt': return { acc: '#8FD3E8', ink: '#ECDEBE', star: '#FFD696', ref: '#D98A6A', fam, clear, neg: false };
      case 'nvg': return { acc: '#78ff96', ink: '#BEFFC8', star: '#E1FFCD', ref: '#B9FF9E', fam, clear, neg: false };
      case 'thermal': return { acc: '#ffb050', ink: '#FFECD6', star: '#FFF4D6', ref: '#FF8A50', fam, clear, neg: false };
      default: return { acc: '#8FD3E8', ink: '#D6DCE3', star: '#FFE8BE', ref: '#D98A6A', fam, clear, neg: false };
    }
  }
  function applyPalette(): void {
    const pal = palette();
    const c = (h: string): THREE.Color => (pal.neg ? negOf(h) : new THREE.Color(h));
    (gU.uAcc as { value: THREE.Color }).value.copy(c(pal.acc));
    (gU.uInk as { value: THREE.Color }).value.copy(c(pal.ink));
    (gU.uRef as { value: THREE.Color }).value.copy(c(pal.ref));
    (pU.uAcc as { value: THREE.Color }).value.copy(c(pal.acc));
    (pU.uInk as { value: THREE.Color }).value.copy(c(pal.ink));
    (pU.uStar as { value: THREE.Color }).value.copy(c(pal.star));
    pU.uDim.value = pal.neg ? 0.8 : 0.72;
    pal.fam.forEach((f, i) => {
      const col = c(f);
      P.forEach((p) => {
        if (p.fam === i) {
          aCol[p.i * 3] = col.r;
          aCol[p.i * 3 + 1] = col.g;
          aCol[p.i * 3 + 2] = col.b;
        }
      });
    });
    colAttr.needsUpdate = true;
    renderer.setClearColor(pal.clear, 1);
    if (fanRow) (fanRow.material as THREE.LineBasicMaterial).color.copy(c(pal.acc));
    if (fanCol) (fanCol.material as THREE.LineBasicMaterial).color.copy(c(pal.ink));
    el.toggleAttribute('data-light', pal.neg);
    el.dataset.mode = state.mode;
    keyEl.querySelectorAll<HTMLElement>('.gl-sw').forEach((sw) => {
      const f = FAM[Number(sw.dataset.fam)] as FamilyDef;
      const col = pal.neg ? f.light : f.dark;
      sw.style.background = col;
      sw.style.color = col;
    });
    mapDirty = true;
  }

  /* ------------------------------------------------ selection state -> attributes, arcs, panels */
  function setKinds(holeIdx: number): void {
    aKind.fill(0);
    const hole = H[holeIdx];
    if (hole) {
      hole.rowIdx.forEach((k) => (aKind[k] = 1));
      hole.colIdx.forEach((k) => (aKind[k] = 2));
    }
    aKind[state.track.i] = 3;
    kindAttr.needsUpdate = true;
    gU.uSel.value = holeIdx;
    pU.uHoleSel.value = hole ? 1 : 0;
    updateHoleFlags();
  }
  function rebuildArcs(): void {
    [fanRow, fanCol].forEach((f) => {
      if (f) {
        scene.remove(f);
        f.geometry.dispose();
        (f.material as THREE.Material).dispose();
      }
    });
    fanRow = null;
    fanCol = null;
    const pal = palette();
    const c = (h: string): THREE.Color => (pal.neg ? negOf(h) : new THREE.Color(h));
    const hh = H[state.hole];
    const additive = THREE.AdditiveBlending;
    if (hh) {
      fanRow = new THREE.LineSegments(fanGeo(hh.v3, hh.rowIdx), new THREE.LineBasicMaterial({ color: c(pal.acc), transparent: true, opacity: 0.16, depthWrite: false, blending: additive }));
      fanCol = new THREE.LineSegments(fanGeo(hh.v3, hh.colIdx), new THREE.LineBasicMaterial({ color: c(pal.ink), transparent: true, opacity: 0.16, depthWrite: false, blending: additive }));
      scene.add(fanRow);
      scene.add(fanCol);
    }
    while (arcGroup.children.length) {
      const ch = arcGroup.children.pop() as THREE.Line;
      ch.geometry.dispose();
      (ch.material as THREE.Material).dispose();
    }
    arcMats.length = 0;
    const t = state.track;
    t.nn.forEach(([k]) => addArc(t.v3, (P[k] as GP).v3, c(pal.star), 0.7, 0.012, false));
    if (hh) {
      addArc(hh.v3, hh.rv, c(pal.acc), 0.6, 0.1, true);
      addArc(hh.v3, hh.cv, c(pal.ink), 0.6, 0.1, true);
    }
  }
  function applySelection(): void {
    const t = state.track;
    aNn.fill(0);
    t.nn.forEach(([k]) => (aNn[k] = 1));
    nnAttr.needsUpdate = true;
    pU.uTrkMove.value = t.mv;
    pU.uTrkMat.value = t.mt;
    setKinds(state.hole);
    rebuildArcs();
    renderPanels();
    buildLabels();
    mapDirty = true;
  }
  function updateHoleFlags(): void {
    const L = state.layers;
    const flags = gU.uHF.value as THREE.Vector2[];
    H.forEach((h, i) => {
      const on = (h.reg ? L.holes : L.pooled) || i === state.hole;
      (flags[i] as THREE.Vector2).set(on ? 1 : 0, h.verdict);
    });
  }
  function applyLayers(): void {
    const L = state.layers;
    pU.uTint.value = L.domains ? 1 : 0;
    pU.uVid.value = L.video ? 1 : 0;
    pU.uUseMove.value = L.moves ? 1 : 0;
    pU.uUseMat.value = L.materials ? 1 : 0;
    pU.uNewOn.value = L.newrep ? 1 : 0;
    gU.uRepl.value = L.repl ? 1 : 0;
    keyEl.classList.toggle('off', !L.domains);
    updateHoleFlags();
    mapDirty = true;
  }

  /* ------------------------------------------------ panels */
  const contactEl = $<HTMLElement>('#gl-contact');
  const holecEl = $<HTMLElement>('#gl-holec');
  const catEl = $<HTMLElement>('#gl-cat');

  function holeBlurb(g: GH): { stamp: string; cls: string } {
    const r = g.h.replication;
    if (!g.reg) return { stamp: 'Exploratory · found after pooling, not pre-registered', cls: '' };
    if (!r) return { stamp: 'Candidate · pre-registered · not yet tested', cls: '' };
    if (g.verdict === 1) return { stamp: `Refuted · ${r.observed_new} new report${r.observed_new === 1 ? '' : 's'} in the cell`, cls: 'ref' };
    if (g.verdict === 2) return { stamp: `Underpowered · E new ${fmtE(r.E_new)} is under 2`, cls: '' };
    if (g.verdict === 3) return { stamp: 'Replicated · stayed empty, E new at least 2, pooled q at most 0.10', cls: '' };
    return { stamp: esc(r.verdict), cls: '' };
  }

  function renderContact(): void {
    const t = state.track;
    const p = t.p;
    const s = srcLabel(p.s);
    const fullId = t.id.split('-');
    const lockId = `${(fullId[0] ?? '').slice(0, 3).toUpperCase()}-${fullId[fullId.length - 1]}`;
    contactEl.innerHTML = `
      <div class="top2"><div class="gl-hd" style="flex:1"><b>Tracked contact</b><span class="sp"></span></div><span class="gl-lock"><i></i>${esc(lockId)} · LOCK</span></div>
      <div class="gl-ttl">${esc(p.t)}</div>
      <div class="gl-badges">${p.v ? '<span class="gl-badge v" title="' + esc(ytTitle) + '">VIDEO</span>' : ''}${t.isNew ? '<span class="gl-badge n" title="Gathered after the holes were registered, tagged blind">NEW SAMPLE</span>' : ''}${t.anchor ? '<span class="gl-badge" title="One of 84 representative tasks drawn from Anthropic’s usage reports, not one person’s report">REPRESENTATIVE TASK</span>' : ''}<span class="gl-badge">${esc(p.d)}</span></div>
      <div class="gl-body">${esc(p.tx)}</div>
      <div class="gl-src"><b>SOURCE</b><a href="${esc(safeHref(p.s))}" target="_blank" rel="noopener noreferrer">${s.html}</a>${s.t ? `<span style="flex:none;color:var(--g-star)">t=${esc(s.t)}</span>` : ''}</div>
      <div class="gl-chips"><div class="gl-chip"><small>MOVE</small><span title="${esc(p.mv)}">${esc(p.mv)}</span></div><div class="gl-chip"><small>MATERIAL</small><span title="${esc(p.mt)}">${esc(p.mt)}</span></div><div class="gl-chip"><small>AUDIENCE</small><span title="${esc(p.fr)}">${esc(p.fr)}</span></div></div>
      <div class="gl-nnh"><div class="gl-hd" style="flex:1"><b>Nearest contacts</b><span class="sp"></span></div><em>ANGLE ON THE GLOBE</em></div>
      <div id="gl-nnl">${t.nn.slice(0, 3).map(([k, dg], i) => `<button type="button" class="gl-nn" data-i="${k}"><span class="n">N${i + 1}</span><span class="t">${esc((P[k] as GP).p.t)}</span><span class="d">${dg.toFixed(2)}&deg;</span><i style="width:${Math.max(6, (1 - dg / 14) * 100).toFixed(0)}%"></i></button>`).join('')}</div>`;
  }

  function renderHole(): void {
    const g = H[state.hole];
    if (!g) {
      holecEl.innerHTML = '';
      return;
    }
    const h = g.h;
    const r = h.replication;
    const b = holeBlurb(g);
    const [a0, a1] = h.axes;
    const metrics = g.reg && r
      ? `<div><small>E AT REG.</small><b class="a">${esc(fmtE(g.E))}</b><em>${data.meta.N_r1} reports</em></div><div><small>NEW</small><b>${r.observed_new}</b><em>E ${esc(fmtE(r.E_new))}</em></div><div><small>POOLED</small><b>${r.observed_pooled}</b><em>E ${esc(fmtE(r.E_pooled))}</em></div><div><small>q POOL</small><b>${esc(fmtQ(r.q_pooled))}</b><em>BH</em></div>`
      : `<div><small>EXPECTED</small><b class="a">${esc(fmtE(h.E))}</b><em>pooled</em></div><div><small>OBSERVED</small><b>${h.observed}</b><em>of ${fmtN(data.meta.N)}</em></div><div><small>P</small><b>${esc(fmtP(h.p))}</b><em>&nbsp;</em></div><div><small>q</small><b>${esc(fmtQ(h.q))}</b><em>BH</em></div>`;
    holecEl.innerHTML = `
      <div class="gl-hd"><b>Selected hole</b><span class="sp"></span><span class="m">${g.reg ? `${g.i + 1}/${nReg} registered` : 'exploratory'}</span></div>
      <div class="gl-hrow"><span class="gl-hcode">${esc(g.code)}</span><span class="gl-hcell">${esc(h.cell[a0] ?? '')}<span class="x">×</span>${esc(h.cell[a1] ?? '')}</span></div>
      <div class="gl-metrics">${metrics}</div>
      <div class="gl-stamp ${b.cls}"><i></i><span>${b.stamp}</span></div>
      <div class="gl-hfoot">Filaments n=${g.rowIdx.length} and n=${g.colIdx.length}, ${g.sep.toFixed(0)}° apart. Bootstrap ${esc(fmtF(g.reg ? (h.registered?.stability ?? h.stability) : h.stability, 2))}: share of resamples where it is still a hole (empty, E ≥ 1).</div>
      <div class="gl-hlinks"><a href="#matrix" data-act="matrix">In the matrix</a><a href="catalog.html?hole=${esc(g.code)}">Its reports</a></div>`;
  }

  function renderCatalog(): void {
    const cell = (g: GH): string => {
      const cls = g.reg ? (g.verdict === 1 ? ' ref' : g.verdict === 2 ? ' und' : '') : ' expl';
      const v = g.verdict === 1 ? 'refuted' : g.verdict === 2 ? 'underpowered' : g.verdict === 3 ? 'replicated' : g.reg ? 'pending' : 'exploratory';
      return `<button type="button" class="gl-c${cls}" data-i="${g.i}" aria-pressed="${g.i === state.hole}" aria-label="${esc(g.code)} ${esc(cellLabel(g.h))}, ${v}" title="${esc(g.code)}: ${esc(cellLabel(g.h))} · ${v}">${esc(g.code.replace('OV-', 'OV'))}<b>${esc(fmtE(g.E))}</b></button>`;
    };
    const regs = H.filter((g) => g.reg);
    const pooled = H.filter((g) => !g.reg);
    catEl.innerHTML = `<div class="gl-hd"><b>Hole catalog</b><span class="sp"></span><span class="m">E AT REGISTRATION</span></div>
      <div class="gl-grid4">${regs.map(cell).join('')}</div>
      <div class="gl-catkey"><span><i class="ref"></i>refuted ${nRefuted}</span><span><i class="und"></i>underpowered ${nUnder}</span><span><i></i>replicated ${nRepl}</span></div>
      ${state.layers.pooled ? `<div class="gl-hd" style="margin-top:10px"><b>Pooled, exploratory</b><span class="sp"></span><span class="m">E POOLED</span></div><div class="gl-grid4 pooled">${pooled.map(cell).join('')}</div>` : ''}`;
  }
  function renderPanels(): void {
    renderContact();
    renderHole();
    renderCatalog();
  }

  contactEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.gl-nn');
    if (b) selectPoint(P[Number(b.dataset.i)] as GP, true);
  });
  catEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.gl-c');
    if (b) selectHole(Number(b.dataset.i), true, true);
  });
  holecEl.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-act="matrix"]');
    if (a) window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code: (H[state.hole] as GH).code, source: 'globe' } }));
  });

  function selectHole(i: number, fly: boolean, fromUser: boolean): void {
    if (!H[i]) return;
    state.hole = i;
    state.hover = -1;
    applySelection();
    const g = H[i] as GH;
    if (fly) {
      const mid = g.v3.clone().add(state.track.v3);
      const m = mid.length() < 0.8 ? g.v3 : mid.normalize();
      flyTo(vlat(m), vlon(m));
    }
    if (fromUser) window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code: g.code, source: 'globe' } }));
  }
  function selectPoint(p: GP, fly: boolean): void {
    state.track = p;
    applySelection();
    if (fly) flyTo(p.lat, p.lon);
  }
  window.addEventListener(SELECT_EVENT, (ev) => {
    const d = (ev as CustomEvent<{ code?: string; source?: string }>).detail;
    if (!d?.code || d.source === 'globe') return;
    const g = holeByCode.get(d.code);
    if (g && g.i !== state.hole) selectHole(g.i, false, false);
  });
  function flyTo(lat: number, lon: number): void {
    const dl = ((lon - cam.lon + 540) % 360) - 180;
    cam.anim = { t0: performance.now(), dur: 900, lat0: cam.lat, lon0: cam.lon, lat1: Math.max(-80, Math.min(80, lat)), dlon: dl };
    wake();
  }

  /* ------------------------------------------------ overlay labels */
  interface Lab { el: HTMLElement }
  let contL: (Lab & { c: GlobeFile['continents'][0]; v: THREE.Vector3 })[] = [];
  let holeL: (Lab & { g: GH })[] = [];
  let nnL: (Lab & { p: GP })[] = [];
  let vidL: (Lab & { p: GP })[] = [];
  let trkL: HTMLElement | null = null;
  let hcall: HTMLElement | null = null;
  const mk = (cls: string, html: string): HTMLElement => {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    labelsEl.appendChild(d);
    return d;
  };
  function buildLabels(): void {
    labelsEl.innerHTML = '';
    contL = G.continents.filter((c) => c.n >= 70).slice(0, 7).map((c) => ({ c, v: llv(c.lat, c.lon), el: mk('gl-lbl gl-cont', `${esc(contName(c))}<small>${esc(c.id)} · n=${c.n}</small>`) }));
    holeL = H.map((g) => ({ g, el: mk(`gl-lbl gl-hl${g.i === state.hole ? ' sel' : ''}${g.verdict === 1 ? ' ref' : ''}`, `<span class="gl-hlx"></span><span class="gl-hlt">${esc(g.code)}</span>`) }));
    vidL = P.filter((p) => p.p.v && p !== state.track).map((p) => ({ p, el: mk('gl-vidl', esc(p.p.t.length > 26 ? `${p.p.t.slice(0, 25)}…` : p.p.t)) }));
    nnL = state.track.nn.map(([k], i) => ({ p: P[k] as GP, el: mk('gl-nnl', `N${i + 1}`) }));
    const t = state.track;
    trkL = mk('gl-trk', `<div class="br"><i></i><i></i><i></i><i></i></div><div class="ln"></div><div class="tx">${esc(t.p.t)}<small>${t.lat >= 0 ? 'N' : 'S'}${Math.abs(t.lat).toFixed(2)} ${t.lon >= 0 ? 'E' : 'W'}${Math.abs(t.lon).toFixed(2)} · ${esc(t.p.d)} · locked</small></div>`);
    const h = H[state.hole];
    hcall = h ? mk('gl-call', `<div class="ln"></div><div class="tx">${esc(h.code)} · ${esc(cellLabel(h.h))}<small>${esc(holeBlurb(h).stamp)}</small></div>`) : null;
  }

  /* ------------------------------------------------ reticle (svg) */
  const NS = 'http://www.w3.org/2000/svg';
  const S = (tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    (parent ?? retEl).appendChild(e);
    return e as SVGElement;
  };
  const rg = S('g', {});
  const rot = S('g', {}, rg);
  const sweep = S('g', {}, rg);
  const stroke = (a: number): string => `rgba(var(--g-ink-rgb),${a})`;
  const styleStroke = (e: SVGElement, col: string): SVGElement => {
    e.style.stroke = col;
    return e;
  };
  styleStroke(S('circle', { r: 100, fill: 'none', 'stroke-width': 1 }, rg), stroke(0.22));
  styleStroke(S('circle', { r: 109, fill: 'none', 'stroke-width': 1, 'stroke-dasharray': '1 5' }, rg), stroke(0.1));
  styleStroke(S('circle', { r: 122, fill: 'none', 'stroke-width': 1 }, rg), stroke(0.16));
  styleStroke(S('circle', { r: 132, fill: 'none', 'stroke-width': 1, 'stroke-dasharray': '2 9' }, rg), stroke(0.07));
  for (let a = 0; a < 360; a += 5) {
    const big = a % 30 === 0;
    const mid = a % 15 === 0;
    const r0 = 122;
    const r1 = big ? 133 : mid ? 129 : 126;
    const c = Math.cos(a * D2R);
    const s = Math.sin(a * D2R);
    styleStroke(S('line', { x1: c * r0, y1: s * r0, x2: c * r1, y2: s * r1, 'stroke-width': 1 }, rot), stroke(big ? 0.55 : 0.3));
    if (big) {
      const tt = S('text', { x: c * 138.5, y: s * 138.5 + 1.1, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace', 'font-size': 3.1, 'letter-spacing': '.1' }, rot);
      tt.style.fill = stroke(0.45);
      tt.textContent = String(a).padStart(3, '0');
    }
  }
  styleStroke(S('path', { d: 'M 0 -122 A 122 122 0 0 1 106 -61', fill: 'none', 'stroke-width': 1.4 }, sweep), 'rgba(var(--g-acc-rgb),.6)');
  styleStroke(S('path', { d: 'M 0 -132 A 132 132 0 0 0 -66 -114', fill: 'none', 'stroke-width': 1.4 }, rot), stroke(0.35));
  const hlin = S('g', {});
  ['hA', 'hB', 'vA', 'vB'].forEach(() => styleStroke(S('line', { 'stroke-width': 1 }, hlin), stroke(0.14)));
  const hl = hlin.querySelectorAll('line');

  /* ------------------------------------------------ post pass (sensor modes, printed negative) */
  let rt: THREE.WebGLRenderTarget | null = null;
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uMode: { value: 0 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: postVS, fragmentShader: postFS, depthTest: false, depthWrite: false,
  });
  const postScene = new THREE.Scene();
  postScene.add(new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), postMat));
  function makeRT(): void {
    rt?.dispose();
    const w = Math.floor(W * PX);
    const h = Math.floor(Hh * PX);
    try {
      const ms = new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat });
      ms.samples = 4;
      rt = ms;
    } catch {
      rt = new THREE.WebGLRenderTarget(w, h);
    }
    (postMat.uniforms.uRes as THREE.IUniform).value.set(w, h);
  }
  function setMode(m: Mode): void {
    state.mode = m;
    el.querySelectorAll<HTMLButtonElement>('#gl-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    applyPalette();
    rebuildArcs();
    wake();
  }
  el.querySelectorAll<HTMLButtonElement>('#gl-seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m as Mode)));

  /* ------------------------------------------------ interaction */
  let drag: { x: number; y: number; moved: number } | null = null;
  const tmpV = new THREE.Vector3();
  function proj(v3: THREE.Vector3, r = 1): { x: number; y: number } {
    tmpV.copy(v3).multiplyScalar(r).project(camera);
    return { x: (tmpV.x * 0.5 + 0.5) * W, y: (-tmpV.y * 0.5 + 0.5) * Hh };
  }
  const facing = (v3: THREE.Vector3): number => v3.dot(camVec()) * cam.base * cam.zoom - 1;
  function pickAt(mx: number, my: number): { p?: GP; h?: GH } {
    let best: GP | undefined;
    let bd = 16 * 16;
    P.forEach((p) => {
      if (facing(p.v3) < 0.02) return;
      const s = proj(p.v3, 1.008);
      const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    });
    if (best) return { p: best };
    let hb: GH | undefined;
    let hd = Infinity;
    H.forEach((h) => {
      const on = h.reg ? state.layers.holes : state.layers.pooled;
      if (!on || facing(h.v3) < 0.02) return;
      const s = proj(h.v3, 1);
      const s2 = proj(llv(h.lat + h.rad / D2R, h.lon), 1);
      const rpx = Math.hypot(s2.x - s.x, s2.y - s.y) * 1.1 + 8;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < rpx && d < hd) { hd = d; hb = h; }
    });
    return { h: hb };
  }
  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('drag');
    cam.anim = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      const k = (0.28 * (cam.base * cam.zoom - 0.85)) / 4;
      cam.lon -= dx * k;
      cam.lat = Math.max(-82, Math.min(82, cam.lat + dy * k));
      wake();
      return;
    }
    if (e.pointerType === 'mouse') {
      const [mx, my] = local(e);
      const r = pickAt(mx, my);
      const hv = !r.p && r.h ? r.h.i : -1;
      if (hv !== state.hover) {
        state.hover = hv;
        setKinds(hv >= 0 ? hv : state.hole);
        canvas.style.cursor = r.p || r.h ? 'pointer' : '';
        wake();
      } else canvas.style.cursor = r.p || r.h ? 'pointer' : '';
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (state.hover !== -1 && !drag) {
      state.hover = -1;
      setKinds(state.hole);
      wake();
    }
  });
  const endDrag = (e: PointerEvent): void => {
    canvas.classList.remove('drag');
    if (drag && drag.moved < 5) {
      const [mx, my] = local(e);
      const r = pickAt(mx, my);
      if (r.p) selectPoint(r.p, false);
      else if (r.h) selectHole(r.h.i, false, true);
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => {
    canvas.classList.remove('drag');
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.shiftKey && Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    cam.zoom = Math.max(0.42, Math.min(1.5, cam.zoom * Math.exp(e.deltaY * 0.0012)));
    wake();
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea')) return;
    const m: Record<string, Mode> = { '1': 'normal', '2': 'crt', '3': 'nvg', '4': 'thermal' };
    const key = e.key;
    if (m[key]) { setMode(m[key] as Mode); return; }
    if (key === 'h' || key === 'H') {
      selectHole((state.hole + 1) % nReg, true, true);
      return;
    }
    if (t === canvas) {
      const step = 8;
      if (key === 'ArrowLeft') cam.lon -= step;
      else if (key === 'ArrowRight') cam.lon += step;
      else if (key === 'ArrowUp') cam.lat = Math.min(82, cam.lat + step);
      else if (key === 'ArrowDown') cam.lat = Math.max(-82, cam.lat - step);
      else if (key === '+' || key === '=') cam.zoom = Math.max(0.42, cam.zoom * 0.9);
      else if (key === '-') cam.zoom = Math.min(1.5, cam.zoom * 1.1);
      else return;
      e.preventDefault();
      wake();
    }
  });

  /* ------------------------------------------------ minimap */
  let landData: Uint8ClampedArray | null = null;
  let mapBase: HTMLCanvasElement | null = null;
  let mapDirty = true;
  function buildMapBase(): void {
    if (!landData) return;
    const w = mapC.width;
    const h = mapC.height;
    const oc = document.createElement('canvas');
    oc.width = w;
    oc.height = h;
    const x = oc.getContext('2d') as CanvasRenderingContext2D;
    const im = x.createImageData(w, h);
    const thr = G.land.threshold_8bit;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const sx = Math.min(359, Math.floor((i / w) * 360));
        const sy = Math.min(179, Math.floor((j / h) * 180));
        const v = landData[(sy * 360 + sx) * 4] as number;
        const o = (j * w + i) * 4;
        const land = v >= thr;
        const t = v / 255;
        im.data[o] = land ? 50 + t * 40 : 6 + t * 6;
        im.data[o + 1] = land ? 54 + t * 40 : 10 + t * 12;
        im.data[o + 2] = land ? 60 + t * 40 : 16 + t * 14;
        im.data[o + 3] = 255;
      }
    }
    x.putImageData(im, 0, 0);
    x.strokeStyle = 'rgba(214,220,227,.08)';
    x.lineWidth = 1;
    x.beginPath();
    for (let a = -180; a <= 180; a += 30) { const px = ((a + 180) / 360) * w; x.moveTo(px, 0); x.lineTo(px, h); }
    for (let a = -90; a <= 90; a += 30) { const py = ((90 - a) / 180) * h; x.moveTo(0, py); x.lineTo(w, py); }
    x.stroke();
    mapBase = oc;
  }
  function drawMap(): void {
    if (!mapBase) return;
    const w = mapC.width;
    const h = mapC.height;
    const X = (lon: number): number => ((lon + 180) / 360) * w;
    const Y = (lat: number): number => ((90 - lat) / 180) * h;
    const pal = palette();
    const famCol = pal.neg ? FAM.map((f) => f.dark) : pal.fam;
    mctx.drawImage(mapBase, 0, 0);
    P.forEach((p) => {
      mctx.fillStyle = state.layers.domains ? (famCol[p.fam] as string) : '#FFE8BE';
      mctx.globalAlpha = p.p.v ? 1 : 0.6;
      const s = p.p.v ? 4.4 : 2.4;
      mctx.fillRect(X(p.lon) - s / 2, Y(p.lat) - s / 2, s, s);
    });
    mctx.globalAlpha = 1;
    const acc = pal.neg ? '#8FD3E8' : pal.acc;
    H.forEach((hh) => {
      const on = hh.reg ? state.layers.holes : state.layers.pooled;
      const sel = hh.i === state.hole;
      if (!on && !sel) return;
      mctx.strokeStyle = state.layers.repl && hh.verdict === 1 ? '#D98A6A' : acc;
      mctx.lineWidth = sel ? 2 : 1;
      mctx.globalAlpha = sel ? 1 : 0.75;
      mctx.beginPath();
      mctx.arc(X(hh.lon), Y(hh.lat), sel ? 9 : 5, 0, 6.283);
      mctx.stroke();
    });
    mctx.globalAlpha = 1;
    const t = state.track;
    mctx.strokeStyle = '#FFE8BE';
    mctx.lineWidth = 1.5;
    mctx.strokeRect(X(t.lon) - 7, Y(t.lat) - 7, 14, 14);
    const d = cam.base * cam.zoom;
    const ang = Math.acos(1 / d);
    const la = cam.lat * D2R;
    const lo = cam.lon * D2R;
    mctx.strokeStyle = 'rgba(255,232,190,.85)';
    mctx.lineWidth = 1.2;
    mctx.beginPath();
    let prev: number | null = null;
    for (let b = 0; b <= 360; b += 4) {
      const br = b * D2R;
      const lat2 = Math.asin(Math.sin(la) * Math.cos(ang) + Math.cos(la) * Math.sin(ang) * Math.cos(br));
      let lon2 = lo + Math.atan2(Math.sin(br) * Math.sin(ang) * Math.cos(la), Math.cos(ang) - Math.sin(la) * Math.sin(lat2));
      lon2 = ((lon2 / D2R + 540) % 360) - 180;
      const px = X(lon2);
      const py = Y(lat2 / D2R);
      if (prev === null || Math.abs(px - prev) > w / 2) mctx.moveTo(px, py);
      else mctx.lineTo(px, py);
      prev = px;
    }
    mctx.stroke();
    mctx.fillStyle = 'rgba(255,232,190,.9)';
    mctx.beginPath();
    mctx.arc(X(cam.lon), Y(cam.lat), 2.6, 0, 6.283);
    mctx.fill();
  }

  /* ------------------------------------------------ frame loop */
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let visible = true;
  let running = false;
  let lastRender = 0;
  let lastTelem = 0;
  const t0 = performance.now();
  const tLat = $<HTMLElement>('#gl-tlat');
  const tLon = $<HTMLElement>('#gl-tlon');
  const tAlt = $<HTMLElement>('#gl-talt');
  const tView = $<HTMLElement>('#gl-tview');
  const camPos = new THREE.Vector3();

  function resize(): void {
    measure();
    renderer.setSize(W, Hh, false);
    camera.aspect = W / Hh;
    PX = renderer.getPixelRatio();
    camera.setViewOffset(W, Hh, Math.round(W / 2 - view.cx), Math.round(Hh / 2 - view.cy), W, Hh);
    camera.updateProjectionMatrix();
    makeRT();
    const sc = PX * (Hh / 1000);
    pU.uPx.value = Math.max(0.55, sc);
  }
  function wake(): void {
    if (!running && visible && !document.hidden) {
      running = true;
      requestAnimationFrame(frame);
    }
  }
  function frame(now: number): void {
    if (!visible || document.hidden) {
      running = false;
      return;
    }
    if (now - lastRender < 28) {
      requestAnimationFrame(frame);
      return;
    }
    lastRender = now;
    const t = reduce ? 0 : (now - t0) / 1000;
    if (cam.anim) {
      const k = Math.min(1, (now - cam.anim.t0) / cam.anim.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      cam.lat = cam.anim.lat0 + (cam.anim.lat1 - cam.anim.lat0) * e;
      cam.lon = cam.anim.lon0 + cam.anim.dlon * e;
      if (k >= 1) cam.anim = null;
    }
    const dist = cam.base * cam.zoom;
    camPos.copy(camVec()).multiplyScalar(dist);
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    pU.uK.value = cam.base;
    pU.uTime.value = t;
    gU.uTime.value = t;
    (postMat.uniforms.uTime as THREE.IUniform).value = t;
    const pal = palette();
    const usePost = state.mode !== 'normal' || pal.neg;
    (postMat.uniforms.uMode as THREE.IUniform).value = pal.neg ? 4 : MODE_NUM[state.mode];
    if (!usePost) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    } else if (rt) {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      (postMat.uniforms.tDiffuse as THREE.IUniform).value = rt.texture;
      renderer.render(postScene, postCam);
    }
    updateOverlay(t, dist, now);
    // with reduced motion nothing animates on its own: sleep until the next interaction
    if (reduce && !cam.anim && !drag) running = false;
    else requestAnimationFrame(frame);
  }
  const setT = (e: HTMLElement, x: number, y: number): void => {
    e.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  };
  function updateOverlay(t: number, dist: number, now: number): void {
    const c = proj(new THREE.Vector3(0, 0, 0), 1);
    const cv = camVec();
    const up = new THREE.Vector3(0, 1, 0);
    const perp = up.clone().sub(cv.clone().multiplyScalar(up.dot(cv))).normalize();
    const lp = cv.clone().multiplyScalar(1 / dist).add(perp.multiplyScalar(Math.sqrt(1 - 1 / (dist * dist))));
    const l = proj(lp, 1);
    const R = Math.hypot(l.x - c.x, l.y - c.y);
    const desktop = window.matchMedia('(min-width: 1100px)').matches;
    rg.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)}) scale(${(R / 100).toFixed(4)})`);
    rot.setAttribute('transform', `rotate(${(t * 1.2).toFixed(2)})`);
    sweep.setAttribute('transform', `rotate(${(t * 9).toFixed(2)})`);
    const gap = R * 1.38;
    const lines: [number, number, number, number][] = [
      [view.x0 - 6, c.y, c.x - gap, c.y], [c.x + gap, c.y, view.x1 + 6, c.y], [c.x, 4, c.x, c.y - gap], [c.x, c.y + gap, c.x, Hh - 4],
    ];
    lines.forEach((ln, i) => {
      const e = hl[i] as SVGLineElement;
      e.setAttribute('x1', String(ln[0])); e.setAttribute('y1', String(ln[1])); e.setAttribute('x2', String(ln[2])); e.setAttribute('y2', String(ln[3]));
      e.style.display = desktop ? '' : 'none';
    });

    const L = state.layers;
    contL.forEach((o) => {
      const f = o.v.dot(cv);
      if (!L.domains || f < 0.42 || !desktop) { o.el.style.opacity = '0'; return; }
      const s = proj(o.v, 1);
      o.el.style.opacity = String(Math.min(1, (f - 0.42) * 3.2));
      setT(o.el, s.x - o.el.offsetWidth / 2, s.y - 12);
    });
    const shown = H[state.hover >= 0 ? state.hover : state.hole];
    holeL.forEach((o) => {
      const g = o.g;
      const on = g.reg ? L.holes : L.pooled;
      const isSel = g === shown;
      const f = g.v3.dot(cv);
      // on phones only the selected ring keeps its code on the plot; the others are the numbered list below it
      if ((!on && !isSel) || f < 0.22 || facing(g.v3) <= 0 || (!desktop && g !== H[state.hole])) { o.el.style.opacity = '0'; return; }
      const s = proj(g.v3, 1);
      o.el.classList.toggle('sel', g === H[state.hole]);
      o.el.style.opacity = String(Math.min(1, (f - 0.22) * 3) * (isSel ? 1 : 0.85));
      const rr = g.rad / D2R;
      const e = proj(llv(g.lat - rr * 0.72, g.lon + (rr * 0.72) / Math.max(0.3, Math.cos(g.lat * D2R))), 1);
      const sel = g === H[state.hole];
      setT(o.el, sel ? s.x : e.x, sel ? s.y : e.y);
    });
    const sh = H[state.hole];
    if (hcall) {
      if (sh && facing(sh.v3) > 0.04 && desktop) {
        const f = sh.v3.dot(cv);
        const s = proj(sh.v3, 1);
        const s2 = proj(llv(sh.lat + sh.rad / D2R, sh.lon), 1);
        const rpx = Math.hypot(s2.x - s.x, s2.y - s.y);
        const right = s.x + rpx + 300 < view.x1;
        const sx = right ? 1 : -1;
        const ex = s.x + sx * rpx * 0.74;
        const ey = s.y + rpx * 0.74;
        const tx = ex + sx * 28;
        const ty = ey + 24;
        const ln = hcall.querySelector<HTMLElement>('.ln') as HTMLElement;
        ln.style.width = `${Math.hypot(tx - ex, ty - ey)}px`;
        ln.style.transform = `translate(${ex}px,${ey}px) rotate(${Math.atan2(ty - ey, tx - ex)}rad)`;
        const txEl = hcall.querySelector<HTMLElement>('.tx') as HTMLElement;
        txEl.style.transform = `translate(${right ? tx + 7 : tx - 257}px,${ty - 6}px)`;
        txEl.style.textAlign = right ? 'left' : 'right';
        hcall.style.opacity = String(Math.min(1, f * 4));
      } else hcall.style.opacity = '0';
    }
    const tp = state.track;
    const tf = facing(tp.v3);
    if (trkL) {
      if (tf > 0.03) {
        const s = proj(tp.v3, 1.008);
        trkL.style.opacity = '1';
        trkL.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`;
        const br = trkL.querySelector<HTMLElement>('.br') as HTMLElement;
        const sc = 1 + 0.07 * Math.sin(t * 3.2);
        br.style.transform = `scale(${sc.toFixed(3)}) rotate(${(Math.sin(t * 0.8) * 4).toFixed(2)}deg)`;
        const tx = trkL.querySelector<HTMLElement>('.tx') as HTMLElement;
        const ln = trkL.querySelector<HTMLElement>('.ln') as HTMLElement;
        // the callout flips to the roomier side so it never runs off the stage
        const right = s.x < view.x1 - 250;
        const dx = right ? 58 : -58;
        const dy = s.y > 120 ? -62 : 62;
        ln.style.width = `${Math.hypot(dx, dy) - 18}px`;
        ln.style.transform = `translate(${dx > 0 ? 10 : -10}px,${dy < 0 ? -10 : 10}px) rotate(${Math.atan2(dy + (dy < 0 ? 10 : -10), dx + (dx > 0 ? -10 : 10))}rad)`;
        tx.style.transform = `translate(${right ? dx + 8 : dx - 218}px,${dy < 0 ? dy - 20 : dy + 4}px)`;
        tx.style.textAlign = right ? 'left' : 'right';
        tx.style.display = desktop ? '' : 'none';
      } else trkL.style.opacity = '0';
    }
    nnL.forEach((o) => {
      const f = facing(o.p.v3);
      if (f < 0.05) { o.el.style.opacity = '0'; return; }
      const s = proj(o.p.v3, 1.008);
      const ts = proj(state.track.v3, 1.008);
      if (Math.hypot(s.x - ts.x, s.y - ts.y) < 16) { o.el.style.opacity = '0'; return; }
      o.el.style.opacity = String(Math.min(1, f * 6));
      setT(o.el, s.x + 9, s.y + 3);
    });
    {
      const taken: [number, number, number, number][] = [];
      const ts = proj(state.track.v3, 1.008);
      taken.push([ts.x - 20, ts.y - 70, ts.x + 240, ts.y + 70]);
      if (sh) { const hs = proj(sh.v3, 1); taken.push([hs.x - 60, hs.y - 60, hs.x + 300, hs.y + 140]); }
      nnL.forEach((o) => { const s = proj(o.p.v3, 1.008); taken.push([s.x, s.y - 8, s.x + 30, s.y + 10]); });
      let n = 0;
      const cand = vidL.map((o) => ({ o, f: facing(o.p.v3) })).filter((x) => x.f > 0.2 && L.video && desktop).sort((a, b) => b.f - a.f);
      vidL.forEach((o) => (o.el.style.opacity = '0'));
      cand.forEach(({ o, f }) => {
        if (n >= 3) return;
        const s = proj(o.p.v3, 1.008);
        const w = o.el.offsetWidth || 120;
        const r: [number, number, number, number] = [s.x + 4, s.y - 9, s.x + 14 + w, s.y + 7];
        if (s.x < view.x0 + 10 || s.x + w + 14 > view.x1) return;
        if (taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) return;
        taken.push(r);
        n++;
        o.el.style.opacity = String(Math.min(0.9, f * 3) * 0.9);
        setT(o.el, s.x + 10, s.y - 4);
      });
    }
    if (now - lastTelem > 120) {
      lastTelem = now;
      tLat.textContent = `${cam.lat >= 0 ? '+' : '−'}${Math.abs(cam.lat).toFixed(1).padStart(4, '0')}°`;
      const lo = ((cam.lon + 540) % 360) - 180;
      tLon.textContent = `${lo >= 0 ? '+' : '−'}${Math.abs(lo).toFixed(1).padStart(5, '0')}°`;
      tAlt.innerHTML = `${(dist - 1).toFixed(2)} <span>R</span>`;
      let n = 0;
      P.forEach((p) => { if (facing(p.v3) > 0) n++; });
      tView.innerHTML = `${n} <span>/ ${NP}</span>`;
      drawMap();
      mapDirty = false;
    }
  }

  /* ------------------------------------------------ boot */
  {
    const cvs = document.createElement('canvas');
    cvs.width = landImg.width;
    cvs.height = landImg.height;
    const x = cvs.getContext('2d') as CanvasRenderingContext2D;
    x.drawImage(landImg, 0, 0);
    const id = x.getImageData(0, 0, landImg.width, landImg.height);
    landData = id.data;
    const tex = new THREE.DataTexture(new Uint8Array(id.data.buffer.slice(0)), landImg.width, landImg.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    gU.uLand.value = tex;
    (gU.uTexSize.value as THREE.Vector2).set(landImg.width, landImg.height);
  }
  buildMapBase();
  // start with the selected hole and the tracked contact both in view
  {
    const hv = (H[state.hole] as GH).v3;
    const m = hv.clone().multiplyScalar(0.72).add(state.track.v3.clone().multiplyScalar(0.28)).normalize();
    cam.lat = Math.max(-55, Math.min(55, vlat(m)));
    cam.lon = vlon(m);
  }
  resize();
  const ro = new ResizeObserver(() => { resize(); wake(); });
  ro.observe(el);
  window.addEventListener('resize', () => { resize(); wake(); });
  applyPalette();
  applyLayers();
  applySelection();
  const onTheme = (): void => {
    state.light = isLight();
    applyPalette();
    rebuildArcs();
    wake();
  };
  window.addEventListener('overhang:theme', onTheme);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', onTheme);
  new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    if (visible) wake();
  }).observe(el);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  running = true;
  requestAnimationFrame(frame);

  // a small hook for the page's own checks and screenshots
  (window as unknown as { __globe?: unknown }).__globe = {
    select: (code: string) => { const g = holeByCode.get(code); if (g) selectHole(g.i, true, false); },
    mode: (m: Mode) => setMode(m),
    cam,
    state,
  };
  return true;
}

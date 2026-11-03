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
import { isLight, motionOff, setMotionOff } from './theme';
import type { LiveCtl, LiveHost, LivePlaced } from './live';

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

/** overlays.json: the 18 concepts and the prior-art findings, placed with the live_index recipe */
interface OvConcept {
  id: string;
  hole: string;
  code: string;
  cell: string;
  title: string;
  text: string;
  pitch: string;
  land: { lands_in_gap: boolean; pct_bge: number | null; pct_nomic: number | null; cos_to_target: number | null; nearest_cos: number | null; nearest_title: string | null };
  prior_art_ai: string;
  prior_art_product: string;
  picked?: boolean;
  name?: string;
  lat: number;
  lon: number;
  R: number;
}
interface OvPrior {
  url: string;
  what: string;
  how_close: number;
  uses_ai: boolean;
  threatens: string[];
  context: { concept: string; lens: string; verdict: string; how_close: number }[];
  lat: number;
  lon: number;
  R: number;
}
interface Overlays {
  concepts: OvConcept[];
  prior_art: OvPrior[];
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
uniform vec4 uHC[NH]; uniform vec2 uHF[NH]; uniform float uSel; uniform float uRepl; uniform float uFlashI; uniform float uFlashA; uniform vec3 uAcc; uniform vec3 uInk; uniform vec3 uRef;
uniform vec3 uOc0; uniform vec3 uOc1; uniform vec3 uLa0; uniform vec3 uLa1; uniform vec3 uShore; uniform vec3 uFres;
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
  vec3 ocean=mix(uOc0,uOc1,voidn*voidn);
  float shore=smoothstep(uThr-0.16,uThr,h)*(1.0-land);
  ocean+=uShore*shore;
  vec3 landc=mix(uLa0,uLa1,smoothstep(uThr,0.98,h));
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
    float flA=(abs(float(i)-uFlashI)<0.5)?uFlashA:0.0;
    float en=max(uHF[i].x,flA);
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
    float pooled=step(3.5,uHF[i].y);
    dash=mix(dash,1.0,pooled);
    float a=rg*dash*mix(0.55,1.0,sel)*mix(1.0,0.8,pooled);
    float rgP=1.0-smoothstep(0.0012,0.0012+fw*1.1,abs(ang-r*0.74));
    a+=pooled*rgP*0.8;
    float r2b=r*0.52;
    float rg2=1.0-smoothstep(0.0011,0.0011+fw*1.1,abs(ang-r2b));
    float ph2=fract(az/6.2831853*24.0-uTime*0.02);
    a+=rg2*smoothstep(0.0,0.1,ph2)*(1.0-smoothstep(0.2,0.3,ph2))*0.5*sel;
    float fill=(1.0-smoothstep(r*0.55,r,ang))*mix(0.035,0.11,sel);
    float wrap=abs(fract(az/1.5707963+0.5)-0.5)*1.5707963*r;
    float tickA=(1.0-smoothstep(0.0012,0.0012+fw,wrap))*smoothstep(r*0.62,r*0.62+0.002,ang)*(1.0-smoothstep(r+0.012,r+0.016,ang))*sel;
    float sweep=pow(fract(az/6.2831853-uTime*0.07),7.0)*(1.0-smoothstep(r*0.96,r,ang))*0.22*sel;
    float on=a+fill+tickA*0.9+sweep;
    on+=flA*(rg*1.5+fill*5.0+(1.0-smoothstep(0.0,0.012,abs(ang-r*(1.0+0.35*(1.0-flA)))))*flA);
    vec3 hcol=uAcc; float dim=1.0;
    if(uRepl>0.5){
      float vd=uHF[i].y;
      if(vd>0.5&&vd<1.5){ hcol=uRef; dim=0.85; } else if(vd>1.5&&vd<2.5){ dim=0.9; }
    }
    hc+=hcol*on*dim*en;
  }
  col+=hc*0.85;
  float fres=pow(1.0-max(dot(N0,normalize(-vView)),0.0),3.0);
  col+=uFres*fres;
  gl_FragColor=vec4(col,1.0);
}`;

const atmoVS = `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`;
const atmoFS = `varying vec3 vN; varying vec3 vP; uniform vec3 uC; void main(){ float d=dot(vN,normalize(-vP)); float x=clamp(-d/0.355,0.0,1.0); float i=pow(x,3.2)*0.55; gl_FragColor=vec4(uC*i,1.0);} `;

const ptsVS = `
attribute vec3 aCol; attribute float aSize; attribute float aVid; attribute float aKind; attribute float aNn; attribute float aMove; attribute float aMat; attribute float aPh; attribute float aNew;
uniform float uPx; uniform float uPs; uniform float uTime; uniform float uK; uniform float uTint; uniform float uVid; uniform vec3 uStar; uniform vec3 uAcc; uniform vec3 uInk;
uniform float uHoleSel; uniform float uUseMove; uniform float uUseMat; uniform float uTrkMove; uniform float uTrkMat; uniform float uDim; uniform float uNewOn;
varying vec3 vCol; varying float vVid; varying float vI; varying float vKind; varying float vMk; varying float vNn;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  float tw=0.93+0.07*sin(uTime*1.4+aPh*6.2831);
  float s=aSize; vec3 base=mix(uStar,aCol,uTint);
  float kind=aKind; float bright=1.0;
  if(kind>0.5&&kind<1.5){ base=uAcc; s*=2.25; bright=2.1; }
  else if(kind>1.5&&kind<2.5){ base=uInk; s*=2.05; bright=1.9; }
  else if(kind>2.5){ base=uStar*1.1; s*=1.7; bright=1.8; }
  else {
    if(uHoleSel>0.5){ bright=uDim; }
    if(uNewOn>0.5){ if(aNew>0.5){ base=mix(base,uAcc,0.9); bright*=1.9; s*=1.3; } else { bright*=0.3; } }
  }
  float vid=aVid*uVid; s*=1.0+vid*1.15; bright*=1.0+vid*0.55;
  if(aNn>0.5){ s*=1.25; bright*=1.25; }
  float mk=0.0;
  if(uUseMove>0.5&&abs(aMove-uTrkMove)<0.5) mk=1.0;
  if(uUseMat>0.5&&abs(aMat-uTrkMat)<0.5) mk=max(mk,2.0);
  if(mk>0.5) s=max(s,13.0);
  float facing=dot(normalize(position),normalize(cameraPosition));
  float fade=smoothstep(0.02,0.22,facing);
  gl_PointSize=s*uPx*uPs*(uK/-mv.z)*tw;
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

const cometVS = `
attribute float aA; attribute float aS; attribute float aK; attribute float aPh;
uniform float uPx; uniform float uTime; uniform float uK;
varying float vA; varying float vK;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  float facing=dot(normalize(position),normalize(cameraPosition));
  float fade=(length(position)>1.05)?1.0:smoothstep(0.02,0.22,facing);
  float pulse=(aK>2.5)?(1.0+0.16*sin(uTime*3.0+aPh*6.2831)):1.0;
  gl_PointSize=aS*uPx*(uK/-mv.z)*pulse;
  vA=aA*fade; vK=aK;
}`;
const cometFS = `
precision highp float;
uniform vec3 uHead; uniform vec3 uAcc; varying float vA; varying float vK;
void main(){
  vec2 p=gl_PointCoord*2.0-1.0; float r=length(p);
  if(r>1.0||vA<0.01) discard;
  vec3 c;
  if(vK<0.5){ float core=exp(-r*r*14.0); float halo=pow(max(1.0-r,0.0),2.0); c=uHead*(core*1.6+halo*0.5); }
  else if(vK<1.5){ float g=exp(-r*r*5.0); c=mix(uAcc,uHead,0.3)*g*0.9; }
  else if(vK<2.5){ float rg=1.0-smoothstep(0.0,0.08,abs(r-0.8)); c=uAcc*rg*1.2; }
  else { float core=exp(-r*r*18.0); float rg=1.0-smoothstep(0.0,0.07,abs(r-0.72)); c=uHead*core*1.5+uAcc*rg*0.95; }
  gl_FragColor=vec4(c*vA,1.0);
}`;

/* soft arcs: per-vertex intensity colour, faded toward the horizon so far-side parts disappear instead of cutting across the globe */
const arcVS = `attribute vec3 aC; varying vec3 vC; varying float vF;
void main(){ vC=aC; float f=dot(normalize(position),normalize(cameraPosition)); vF=smoothstep(0.07,0.34,f); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const arcFS = `precision highp float; varying vec3 vC; varying float vF; uniform float uO;
void main(){ gl_FragColor=vec4(vC*vF*uO,1.0); }`;

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

/** #OV-15 selects a hole, #T-<id> tracks an item; both may be joined with & */
function parseHash(): { hole?: string; track?: string } {
  const out: { hole?: string; track?: string } = {};
  let h = location.hash.replace(/^#/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    /* keep the raw text */
  }
  h.split('&').forEach((tok) => {
    const a = /^(OV-\d{1,3})$/i.exec(tok);
    if (a) out.hole = (a[1] as string).toUpperCase();
    const b = /^T-(.+)$/i.exec(tok);
    if (b) out.track = b[1] as string;
  });
  return out;
}

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
      <div class="gl-mks" aria-hidden="true"><div class="gl-mk-g" data-g="p"></div><div class="gl-mk-g" data-g="c"></div></div>
      <div class="gl-card" id="gl-card" hidden></div>
      <div class="gl-fx"></div>
      <p class="gl-keyhint" aria-hidden="true"><kbd>&larr;</kbd><kbd>&uarr;</kbd><kbd>&rarr;</kbd><kbd>&darr;</kbd> turn &nbsp; <kbd>+</kbd><kbd>&minus;</kbd> zoom &nbsp; <kbd>H</kbd> next hole &nbsp; <kbd>N</kbd> next contact</p>
    </div>
    <i class="gl-vc tl"></i><i class="gl-vc tr"></i><i class="gl-vc bl"></i><i class="gl-vc br"></i>
    <header class="gl-top">
      <div class="gl-cls"><span class="bar">PRE-REGISTERED // TESTED ON NEW REPORTS</span></div>
      <div class="gl-brand"><h1>${esc(fmtN(NP))} things people have done with Claude, and <em>the holes between them.</em></h1></div>
      <div class="gl-meta"><a class="gl-cta" href="#abstract">Read the evidence <span aria-hidden="true">&darr;</span></a></div>
    </header>
    <aside class="gl-panel gl-brk gl-left" id="gl-controls" tabindex="-1" aria-label="Layers"><div class="gl-lin">
      <div class="gl-hd"><b>Layers</b><span class="sp"></span><span class="m">L1</span></div>
      <div id="gl-layers" style="margin-top:8px"></div>
      <div class="gl-sect"><div class="gl-hd"><b>Domain families</b><span class="sp"></span></div><div class="gl-key" id="gl-key" style="margin-top:6px"></div></div>
      <div class="gl-sect gl-conts-sect"><div class="gl-hd"><b>Continents</b><span class="sp"></span><span class="m">REPORTS</span></div><div class="gl-key gl-conts" id="gl-conts" style="margin-top:6px"></div></div>
      <div class="gl-mapwrap">
        <div class="gl-hd" style="margin-bottom:6px"><b>Plate</b><span class="sp"></span><span class="m">EQUIRECT</span></div>
        <canvas class="gl-map" id="gl-map" width="480" height="240" role="img" aria-label="Flat map of the same reports, the rings and the current view"></canvas>
        <div class="gl-legend2"><span><i style="background:rgba(var(--g-ink-rgb),.5)"></i>land = dense</span><span><i style="border:1px solid var(--g-acc);border-radius:50%"></i>hole</span><span><i style="border:1px solid var(--g-star)"></i>view</span></div>
      </div>
    </div></aside>
    <aside class="gl-right" aria-label="Selection">
      <section class="gl-panel gl-brk gl-contact" id="gl-contact" aria-live="polite"></section>
      <section class="gl-panel gl-brk2 gl-holec" id="gl-holec" aria-live="polite"></section>
      <section class="gl-panel gl-brk2 gl-cat" id="gl-cat"></section>
    </aside>
    <p class="gl-foot" id="gl-foot"></p>
    <footer class="gl-bottom">
      <div class="gl-tel">
        <div class="fnd"><small>SAMPLE</small><b>${esc(fmtN(nR1))} <span>+</span> ${esc(fmtN(nNew))} <span>new</span></b></div>
        <div class="fnd"><small>TAGGERS &kappa;</small><b>&ge; ${esc(fmtF(kMin, 3))}</b></div>
        <div class="fnd opt"><small>PREREG</small><b>${esc(meta.prereg_commit)}</b></div>
        <div class="cam"><small>CAM LAT</small><b id="gl-tlat">+00.0&deg;</b></div>
        <div class="cam"><small>CAM LON</small><b id="gl-tlon">+000.0&deg;</b></div>
        <div class="cam opt"><small>ALT</small><b id="gl-talt">0.00 <span>R</span></b></div>
        <div class="cam"><small>IN VIEW</small><b id="gl-tview">0 <span>/ ${NP}</span></b></div>
        <div class="cam opt"><small>PROJECTION</small><b>spherical UMAP <span>&middot; PCA-${esc(meta.pca)}</span></b></div>
      </div>
      <div class="gl-modes">
        <button type="button" class="gl-mot" id="gl-mot" aria-pressed="false" title="Turn the animation off or on. The default follows your system setting.">Motion on</button>
        <small>SENSOR</small>
        <div class="gl-seg" id="gl-seg" role="group" aria-label="Sensor mode">
          <button type="button" data-m="normal" aria-pressed="true"><kbd>1</kbd>Normal</button>
          <button type="button" data-m="crt" aria-pressed="false"><kbd>2</kbd>CRT</button>
          <button type="button" data-m="nvg" aria-pressed="false"><kbd>3</kbd>NVG</button>
          <button type="button" data-m="thermal" aria-pressed="false"><kbd>4</kbd>Thermal</button>
        </div>
      </div>
    </footer>
    <div class="gl-selbar" id="gl-selbar" role="status"></div>`;

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
  const hashSel = parseHash();
  const qs = new URLSearchParams(location.search);
  const winnerCode = data.winner.status === 'built' ? data.winner.code : data.winner.pick?.code;
  const pick0 = (hashSel.hole ? holeByCode.get(hashSel.hole) : undefined) ?? (winnerCode ? holeByCode.get(winnerCode) : undefined) ?? (H[0] as GH);
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
  /* The default story: the first screen tracks a video device hack on the firmware coast (the smart-TV ad-strip item from the video: from_video, material
   * "consumer-device firmware or hardware") with OV-15 selected, so the contact and the ring read together. Deep links still win: a #T- id tracks that item,
   * and a #OV- code other than the story's hole tracks the video item nearest to it, as before. */
  const STORY_TRACK_ID = 'video-001';
  const storyTrack = byId.get(STORY_TRACK_ID);
  const storyDefault = !hashSel.track && !!storyTrack && storyTrack.p.v && storyTrack.p.mt === pick0.h.cell.material && pick0.code === winnerCode;
  const state = {
    track: (hashSel.track ? byId.get(hashSel.track) : undefined) ?? (storyDefault ? storyTrack : undefined) ?? nearestVideo(pick0),
    hole: pick0.i,
    hover: -1,
    nnHover: -1, // which of the tracked contact's nearest contacts is hovered (N4 to N6 show their number only then)
    nnAll: false, // the panel's list shows all six
    contHover: -1, // a continent row hovered in the left rail shows its label on the globe
    textOpen: false,
    mode: 'normal' as Mode,
    light: isLight(),
    layers: { domains: true, moves: false, materials: false, video: true, newrep: false, holes: true, pooled: false, repl: true, concepts: true, prior: false, live: false },
  };
  // ?layers=prior,live,-concepts presets the layers (a hash cannot: the hash is the selection)
  (qs.get('layers') ?? '').split(',').forEach((t) => {
    const off = t.startsWith('-');
    const k = (off ? t.slice(1) : t).trim() === 'priorart' ? 'prior' : (off ? t.slice(1) : t).trim();
    if (k in state.layers) (state.layers as Record<string, boolean>)[k] = !off;
  });
  type LayerKey = keyof typeof state.layers;

  /* ------------------------------------------------ static UI */
  const layerDefs: { k: LayerKey; name: string; ct: string; cls: string; tip: string }[] = [
    { k: 'domains', name: 'Domain families', ct: String(FAM.length), cls: '', tip: `Tint every report by its domain family (${FAM.length} families; the corpus has ${new Set(P.map((p) => p.p.d)).size} domains)` },
    { k: 'moves', name: 'Moves', ct: String(moves.length), cls: '', tip: 'Mark every report that shares the tracked contact’s move' },
    { k: 'materials', name: 'Materials', ct: String(mats.length), cls: '', tip: 'Mark every report that shares the tracked contact’s material' },
    { k: 'video', name: 'Video', ct: String(nVideo), cls: '', tip: 'Reports flagged as from the one video' },
    { k: 'newrep', name: 'New sample', ct: fmtN(nNew), cls: '', tip: `The ${fmtN(nNew)} blind reports gathered after the holes were registered: tinted with the accent, the older reports dimmed` },
    { k: 'holes', name: 'Holes', ct: String(nReg), cls: 'hole', tip: `The ${nReg} pre-registered holes` },
    { k: 'pooled', name: 'Pooled holes', ct: String(nPooled), cls: 'hole', tip: `${nPooled} more empty cells found after pooling, not pre-registered: exploratory (drawn as double rings)` },
    { k: 'repl', name: 'Replication', ct: `${nRefuted}/${nUnder}/${nRepl}`, cls: 'hole', tip: 'Colour the rings by verdict: refuted / underpowered / replicated' },
    { k: 'concepts', name: 'Concepts', ct: '…', cls: 'hole', tip: 'The concepts written for the holes, as diamonds where their text lands on the globe. Hover for the card.' },
    { k: 'prior', name: 'Prior-art items', ct: '…', cls: 'ref', tip: 'What already exists: distinct sources found by the 36 prior-art searches (a different unit from the searches), each with an arc to the concepts it threatens. The full tables are in the Built section.' },
    { k: 'live', name: 'LIVE', ct: 'HN', cls: 'live', tip: 'Newest Hacker News stories that mention Claude, placed on the globe by the same method (asks before it downloads a 33 MB model, once)' },
  ];
  layerDefs.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gl-layer ${d.cls}`;
    b.dataset.k = d.k;
    b.title = d.tip;
    b.setAttribute('aria-pressed', String(state.layers[d.k]));
    b.innerHTML = d.k === 'live'
      ? `<span class="bx dot"></span><span class="nm">${d.name}</span><span class="ct">${d.ct}</span>`
      : `<span class="bx"></span><span class="nm">${d.name}</span><span class="ct">${d.ct}</span>`;
    b.addEventListener('click', () => {
      if (d.k === 'live') {
        void setLive(!state.layers.live);
        return;
      }
      state.layers[d.k] = !state.layers[d.k];
      b.setAttribute('aria-pressed', String(state.layers[d.k]));
      if (!state.layers[d.k]) closeCard();
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
    .slice(0, 4)
    .map((c, i) => `<div class="row" data-cid="${esc(c.id)}" tabindex="0" title="Show this continent's label on the globe"><span class="id">${esc(c.id)}</span><span class="nm" title="${esc(c.name ?? '')}">${esc(contName(c))}</span><span class="ct">${c.n}</span></div>`)
    .join('');
  const contRows = $('#gl-conts');
  const setCont = (e: Event, on: boolean): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-cid]');
    const i = on && row ? contL.findIndex((o) => o.c.id === row.dataset.cid) : -1;
    if (i !== state.contHover) { state.contHover = i; wake(); }
  };
  contRows.addEventListener('pointerover', (e) => setCont(e, true));
  contRows.addEventListener('pointerleave', (e) => setCont(e, false));
  contRows.addEventListener('focusin', (e) => setCont(e, true));
  contRows.addEventListener('focusout', (e) => setCont(e, false));
  const overlap = G.stats.neighbour_overlap_globe_vs_full_at6;
  foot.innerHTML = `<b>Figure 1. Honest globe.</b> A spherical UMAP of unit embeddings: angles are projected${overlap != null ? `, ${Math.round(overlap * 100)}% of 6-nearest neighbours survive` : ''}. Land is dense, ocean sparse. A ring is the midpoint of two filaments, never empty space.`;

  /** a rail that scrolls inside its own box says so: a fade at the edge that has more behind it */
  function railFade(box: HTMLElement, watch: HTMLElement = box): void {
    const upd = (): void => {
      box.toggleAttribute('data-more', box.scrollHeight - box.clientHeight - box.scrollTop > 4);
      box.toggleAttribute('data-less', box.scrollTop > 4);
    };
    box.addEventListener('scroll', upd, { passive: true });
    new ResizeObserver(upd).observe(box);
    new MutationObserver(upd).observe(watch, { childList: true, subtree: true });
    upd();
  }
  railFade($<HTMLElement>('.gl-lin'));
  railFade(rightEl);

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
  let view = { cx: 0, cy: 0, x0: 0, x1: 0, y0: 0, y1: 0 };

  // the camera direction, recomputed only when the camera moved (it is read many times per frame)
  const camV = new THREE.Vector3(1, 0, 0);
  let camVLat = NaN;
  let camVLon = NaN;
  const camVec = (): THREE.Vector3 => {
    if (camVLat !== cam.lat || camVLon !== cam.lon) {
      camVLat = cam.lat;
      camVLon = cam.lon;
      const la = cam.lat * D2R;
      const lo = cam.lon * D2R;
      camV.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    }
    return camV;
  };

  let footGap = 0;
  function measure(): void {
    const r = stage.getBoundingClientRect();
    W = Math.max(2, Math.round(r.width));
    Hh = Math.max(2, Math.round(r.height));
    const desktop = window.matchMedia('(min-width: 1100px)').matches;
    let x0 = 8;
    let x1 = W - 8;
    let y0 = 8;
    let y1 = Hh - 8;
    let shift = 0;
    if (desktop) {
      const lr = leftEl.getBoundingClientRect();
      const rr = rightEl.getBoundingClientRect();
      const tr = topEl.getBoundingClientRect();
      const br = bottomEl.getBoundingClientRect();
      const fr = foot.getBoundingClientRect();
      x0 = lr.right - r.left + 14;
      x1 = rr.left - r.left - 14;
      y0 = tr.bottom - r.top + 10;
      y1 = br.top - r.top - 4;
      // the caption sits under the globe, not on its lower limb
      // (kept when LIVE hides the caption, so the globe does not change size)
      if (fr.height > 0 && getComputedStyle(foot).display !== 'none') footGap = br.top - fr.top;
      y1 = Math.min(y1, br.top - r.top - footGap - 4);
      // with LIVE open the globe keeps its size and moves up (view.cy), so the panel covers a little of the lower limb instead of shrinking the globe
      const lv = el.querySelector<HTMLElement>('.gl-live.open');
      if (lv) {
        const over = y1 - (lv.getBoundingClientRect().top - r.top - 10);
        const slack = (y1 - y0) / 2 - Math.min(x1 - x0, y1 - y0) * 0.5 * 0.93; // room above the disc before it reaches the headline
        shift = Math.max(0, Math.min(over * 0.6, slack + 14));
      }
    }
    const fw = x1 - x0;
    const fh = y1 - y0;
    view = { cx: x0 + fw / 2, cy: y0 + fh / 2 - shift, x0, x1, y0, y1 };
    retEl.style.clipPath = desktop ? `inset(${Math.max(0, y0 - 4)}px 0 ${Math.max(0, Hh - y1 - 2)}px 0)` : '';
    const Rpx = Math.min(fw, fh) * 0.5 * (desktop ? 0.93 : 0.92);
    const sq = (Hh / 2) / (Math.tan(15 * D2R) * Rpx);
    cam.base = Math.sqrt(sq * sq + 1);
  }

  const gU: Record<string, THREE.IUniform> = {
    uLand: { value: null }, uTexSize: { value: new THREE.Vector2(360, 180) }, uThr: { value: G.land.threshold_8bit / 255 },
    uTime: { value: 0 }, uHC: { value: H.map((h) => new THREE.Vector4(h.v3.x, h.v3.y, h.v3.z, h.rad)) }, uHF: { value: H.map(() => new THREE.Vector2(1, 0)) },
    uSel: { value: state.hole }, uRepl: { value: 1 }, uFlashI: { value: -1 }, uFlashA: { value: 0 }, uAcc: { value: new THREE.Color('#8FD3E8') }, uInk: { value: new THREE.Color('#D6DCE3') },
    uRef: { value: new THREE.Color('#D98A6A') }, uBump: { value: 0.55 },
    uOc0: { value: new THREE.Color(0.012, 0.020, 0.030) }, uOc1: { value: new THREE.Color(0.030, 0.085, 0.105) },
    uLa0: { value: new THREE.Color(0.105, 0.112, 0.120) }, uLa1: { value: new THREE.Color(0.250, 0.252, 0.250) },
    uShore: { value: new THREE.Color(0.020, 0.026, 0.030) }, uFres: { value: new THREE.Color(0.055, 0.077, 0.094) },
  };
  const pU: Record<string, THREE.IUniform> = {
    uPx: { value: 1 }, uPs: { value: 1 }, uTime: { value: 0 }, uK: { value: 5 }, uTint: { value: 1 }, uVid: { value: 1 }, uStar: { value: new THREE.Color('#FFE8BE') },
    uAcc: { value: new THREE.Color('#8FD3E8') }, uInk: { value: new THREE.Color('#E8ECF0') }, uHoleSel: { value: 1 }, uUseMove: { value: 0 }, uUseMat: { value: 0 },
    uTrkMove: { value: -1 }, uTrkMat: { value: -1 }, uDim: { value: 0.5 }, uNewOn: { value: 0 },
  };

  const globe = new THREE.Mesh(
    new THREE.SphereBufferGeometry(1, 128, 96),
    new THREE.ShaderMaterial({ uniforms: gU, vertexShader: globeVS, fragmentShader: globeFS(NH), extensions: { derivatives: true } }),
  );
  scene.add(globe);
  const atmoC = new THREE.Color(0.3, 0.4, 0.46);
  const atmo = new THREE.Mesh(
    new THREE.SphereBufferGeometry(1.07, 64, 48),
    new THREE.ShaderMaterial({ uniforms: { uC: { value: atmoC } }, vertexShader: atmoVS, fragmentShader: atmoFS, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
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

  /* ------------------------------------------------ LIVE comets: each story drops onto the globe, then rests as a marker with a ring */
  const CM_MAX = 48;
  const CM_TR = 6;
  const CM_ST = CM_TR + 2; // head, trail, ripple
  const cmPos = new Float32Array(CM_MAX * CM_ST * 3);
  const cmA = new Float32Array(CM_MAX * CM_ST);
  const cmS = new Float32Array(CM_MAX * CM_ST);
  const cmK = new Float32Array(CM_MAX * CM_ST);
  const cmPh = new Float32Array(CM_MAX * CM_ST);
  const cmGeo = new THREE.BufferGeometry();
  const cmPosAttr = new THREE.BufferAttribute(cmPos, 3);
  const cmAAttr = new THREE.BufferAttribute(cmA, 1);
  const cmSAttr = new THREE.BufferAttribute(cmS, 1);
  const cmKAttr = new THREE.BufferAttribute(cmK, 1);
  cmGeo.setAttribute('position', cmPosAttr);
  cmGeo.setAttribute('aA', cmAAttr);
  cmGeo.setAttribute('aS', cmSAttr);
  cmGeo.setAttribute('aK', cmKAttr);
  cmGeo.setAttribute('aPh', new THREE.BufferAttribute(cmPh, 1));
  cmGeo.setDrawRange(0, 0);
  const cometMat = new THREE.ShaderMaterial({
    uniforms: { uPx: pU.uPx as THREE.IUniform, uK: pU.uK as THREE.IUniform, uTime: pU.uTime as THREE.IUniform, uHead: pU.uStar as THREE.IUniform, uAcc: pU.uAcc as THREE.IUniform },
    vertexShader: cometVS, fragmentShader: cometFS, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const cometPts = new THREE.Points(cmGeo, cometMat);
  cometPts.frustumCulled = false;
  cometPts.visible = false;
  scene.add(cometPts);
  interface Comet { it: LivePlaced; v3: THREE.Vector3; d0: THREE.Vector3; t0: number; dur: number; landed: boolean }
  let comets: Comet[] = [];
  let cmEnd = 0;
  let cmSel = -1;
  const cmPoint = new THREE.Vector3();
  function cometAt(c: Comet, u: number): THREE.Vector3 {
    const e = 1 - Math.pow(1 - u, 3);
    cmPoint.copy(c.d0).lerp(c.v3, e).normalize().multiplyScalar(1.008 + 0.75 * (1 - e) * (1 - e));
    return cmPoint;
  }
  function setComets(items: LivePlaced[]): void {
    const now = performance.now();
    comets = items.slice(0, CM_MAX).map((it, i) => {
      const v3 = llv(it.lat, it.lon);
      const t = v3.clone().cross(new THREE.Vector3(0, 1, 0));
      if (t.lengthSq() < 1e-4) t.set(1, 0, 0);
      t.normalize();
      const b = v3.clone().cross(t);
      const ang = (20 + ((i * 37) % 17)) * D2R;
      const phi = i * 2.39996;
      const d0 = v3.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t, Math.sin(ang) * Math.cos(phi)).addScaledVector(b, Math.sin(ang) * Math.sin(phi)).normalize();
      return { it, v3, d0, t0: reduce ? -1e9 : now + 150 + i * 85, dur: 1500 + (i % 5) * 120, landed: reduce };
    });
    cmSel = -1;
    cmEnd = comets.reduce((m, c) => Math.max(m, c.t0 + c.dur + 1300), now);
    comets.forEach((c, i) => {
      for (let k = 0; k < CM_ST; k++) {
        const o = i * CM_ST + k;
        cmK[o] = k === 0 ? (c.landed ? 3 : 0) : k <= CM_TR ? 1 : 2;
        cmS[o] = k === 0 ? 14 : k <= CM_TR ? 12 - k * 1.3 : 12;
        cmPh[o] = (i * 0.37 + k * 0.11) % 1;
        cmA[o] = 0;
      }
    });
    cmGeo.setDrawRange(0, comets.length * CM_ST);
    cmKAttr.needsUpdate = true;
    cmSAttr.needsUpdate = true;
    cometPts.visible = state.layers.live && comets.length > 0;
    updateComets(now + 1);
    wake();
  }
  function updateComets(now: number): void {
    if (!comets.length) return;
    comets.forEach((c, i) => {
      const o = i * CM_ST;
      const u = Math.max(0, Math.min(1, (now - c.t0) / c.dur));
      const started = now >= c.t0;
      const head = cometAt(c, u);
      cmPos.set([head.x, head.y, head.z], o * 3);
      if (u >= 1 && !c.landed) {
        c.landed = true;
        cmK[o] = 3;
        cmKAttr.needsUpdate = true;
      }
      cmA[o] = started ? 1 : 0;
      cmS[o] = c.landed ? (i === cmSel ? 24 : 19) : 16 - 4 * u;
      const fadeOut = Math.max(0, Math.min(1, (u - 0.86) / 0.14));
      for (let k = 1; k <= CM_TR; k++) {
        const p = cometAt(c, Math.max(0, u - k * 0.05));
        cmPos.set([p.x, p.y, p.z], (o + k) * 3);
        cmA[o + k] = started ? (1 - k / (CM_TR + 1)) * 0.75 * (1 - fadeOut) : 0;
      }
      const age = now - (c.t0 + c.dur);
      const rp = o + CM_TR + 1;
      cmPos.set([c.v3.x * 1.008, c.v3.y * 1.008, c.v3.z * 1.008], rp * 3);
      if (age >= 0 && age < 1200) {
        const f = age / 1200;
        cmA[rp] = 0.9 * Math.pow(1 - f, 1.5);
        cmS[rp] = 12 + 40 * f;
      } else cmA[rp] = 0;
    });
    cmPosAttr.needsUpdate = true;
    cmAAttr.needsUpdate = true;
    cmSAttr.needsUpdate = true;
  }

  /* arcs: great-circle paths lifted off the surface and bowed sideways, so they read as arcs from any camera angle */
  function arcPts(a: THREE.Vector3, b: THREE.Vector3, lift: number, lateral: number, seg: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const om = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
    const n = a.clone().cross(b);
    if (n.lengthSq() < 1e-9) n.set(0, 1, 0).cross(a);
    if (n.lengthSq() < 1e-9) n.set(1, 0, 0);
    n.normalize();
    const s = Math.sin(om);
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const v = om < 1e-4 ? a.clone() : a.clone().multiplyScalar(Math.sin((1 - t) * om) / s).add(b.clone().multiplyScalar(Math.sin(t * om) / s));
      const bump = Math.sin(Math.PI * t);
      v.addScaledVector(n, lateral * om * bump).normalize().multiplyScalar(1.009 + lift * om * bump);
      out.push(v);
    }
    return out;
  }
  /** A batch of soft arcs: segments whose colour fades along the length and to both endpoints (additive blending, so a darker end is a fainter end). */
  interface ArcBuf { p: number[]; c: number[] }
  const newBuf = (): ArcBuf => ({ p: [], c: [] });
  const endFade = (t: number): number => Math.min(1, t / 0.14, (1 - t) / 0.14);
  /** lift = altitude as a fraction of the angle swept (0.2 puts a 63 degree arc about 0.2 R off the surface); lateral bows it sideways */
  function pushArc(buf: ArcBuf, a: THREE.Vector3, b: THREE.Vector3, lift: number, col: THREE.Color, i0: number, i1: number, dashed = false, lateral = 0): void {
    const om = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
    const seg = Math.max(14, Math.ceil(om / D2R / 2));
    const pts = arcPts(a, b, lift, lateral, seg);
    for (let i = 0; i < seg; i++) {
      if (dashed && i % 4 > 1) continue;
      const A = pts[i] as THREE.Vector3;
      const B = pts[i + 1] as THREE.Vector3;
      const ia = (i0 + (i1 - i0) * (i / seg)) * endFade(i / seg);
      const ib = (i0 + (i1 - i0) * ((i + 1) / seg)) * endFade((i + 1) / seg);
      buf.p.push(A.x, A.y, A.z, B.x, B.y, B.z);
      buf.c.push(col.r * ia, col.g * ia, col.b * ia, col.r * ib, col.g * ib, col.b * ib);
    }
  }
  /** a dashed outline on the surface: the footprint of a filament (the reports carrying one value of the hole's cell) */
  function pushRing(buf: ArcBuf, centre: THREE.Vector3, radius: number, col: THREE.Color, inten: number): void {
    const t1 = new THREE.Vector3(0, 1, 0).cross(centre);
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = centre.clone().cross(t1);
    const seg = 72;
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * Math.PI * 2;
      const v = centre.clone().multiplyScalar(Math.cos(radius)).addScaledVector(t1, Math.sin(radius) * Math.cos(ph)).addScaledVector(t2, Math.sin(radius) * Math.sin(ph)).normalize().multiplyScalar(1.009);
      if (prev && i % 4 !== 0 && i % 4 !== 3) buf.p.push(prev.x, prev.y, prev.z, v.x, v.y, v.z), buf.c.push(col.r * inten, col.g * inten, col.b * inten, col.r * inten, col.g * inten, col.b * inten);
      prev = v;
    }
  }
  function bufLines(buf: ArcBuf, opacity: number): THREE.LineSegments {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3));
    g.setAttribute('aC', new THREE.Float32BufferAttribute(buf.c, 3));
    const l = new THREE.LineSegments(g, new THREE.ShaderMaterial({ uniforms: { uO: { value: opacity } }, vertexShader: arcVS, fragmentShader: arcFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    l.frustumCulled = false;
    return l;
  }
  const disposeLines = (l: THREE.LineSegments | null): void => {
    if (!l) return;
    scene.remove(l);
    l.geometry.dispose();
    (l.material as THREE.Material).dispose();
  };
  const COAST_NEAR = 12;
  let coastArcs: THREE.LineSegments | null = null;
  let trackArcs: THREE.LineSegments | null = null;

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
    pU.uDim.value = pal.neg ? 0.62 : 0.5;
    pU.uPs.value = pal.neg ? 0.8 : 1; // lighter ink reads heavier on paper: 20 percent smaller points
    // the ground. The printed negative inverts the dark render, so a cool grey-blue ground has to be fed to it as its warm complement
    // (feeding it the dark cool tones printed as a warm peach disc). Targets: ocean #E8EDF5 to #D3DBE8, land #CAD3E1 to #B4BFD1, rim #17708C.
    const u = (k: string): THREE.Color => (gU[k] as { value: THREE.Color }).value;
    if (pal.neg) {
      u('uOc0').copy(negOf('#E8EDF5'));
      u('uOc1').copy(negOf('#D3DBE8'));
      u('uLa0').copy(negOf('#CAD3E1'));
      u('uLa1').copy(negOf('#B4BFD1'));
      u('uShore').setRGB(0.03, 0.025, 0.018);
      u('uFres').copy(negOf('#17708C')).multiplyScalar(0.34);
      atmoC.copy(negOf('#17708C')).multiplyScalar(0.75);
    } else {
      u('uOc0').setRGB(0.012, 0.020, 0.030);
      u('uOc1').setRGB(0.030, 0.085, 0.105);
      u('uLa0').setRGB(0.105, 0.112, 0.120);
      u('uLa1').setRGB(0.250, 0.252, 0.250);
      u('uShore').setRGB(0.020, 0.026, 0.030);
      u('uFres').setRGB(0.055, 0.077, 0.094);
      atmoC.setRGB(0.3, 0.4, 0.46);
    }
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
    el.toggleAttribute('data-light', pal.neg);
    el.dataset.mode = state.mode;
    keyEl.querySelectorAll<HTMLElement>('.gl-sw').forEach((sw) => {
      const f = FAM[Number(sw.dataset.fam)] as FamilyDef;
      const col = pal.neg ? f.light : f.dark;
      sw.style.background = col;
      sw.style.color = col;
    });
    buildMapBase();
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
    disposeLines(coastArcs);
    disposeLines(trackArcs);
    coastArcs = null;
    trackArcs = null;
    const pal = palette();
    const c = (h: string): THREE.Color => (pal.neg ? negOf(h) : new THREE.Color(h));
    const hh = H[state.hole];
    if (hh) {
      // the two coasts the hole sits between. Each coast is outlined where its reports are; one bowed arc runs from the hole to each outline,
      // fading along its length, and a fine fan reaches the nearest reports of each coast. Arcs are lifted off the surface and bowed
      // sideways in opposite senses, so the pair reads as an S through the ring and not as one straight chord.
      const buf = newBuf();
      const accC = c(pal.acc);
      const inkC = c(pal.ink);
      ([[hh.rv, hh.rowIdx, accC, 1], [hh.cv, hh.colIdx, inkC, -1]] as [THREE.Vector3, number[], THREE.Color, number][]).forEach(([cen, idx, col, side]) => {
        const angs = idx.map((k) => angDeg(cen, (P[k] as GP).v3)).sort((x, y) => x - y);
        const foot = Math.max(3, Math.min(26, (angs[Math.floor(angs.length * 0.8)] ?? 8))) * D2R;
        pushRing(buf, cen, foot, col, 0.34);
        // end the main arc on the outline, not on the centroid
        const n = hh.v3.clone().cross(cen);
        const om = Math.acos(Math.max(-1, Math.min(1, hh.v3.dot(cen))));
        const tEnd = om > foot * 1.2 ? 1 - foot / om : 1;
        const endV = om < 1e-4 ? cen : hh.v3.clone().multiplyScalar(Math.sin((1 - tEnd) * om) / Math.sin(om)).addScaledVector(cen, Math.sin(tEnd * om) / Math.sin(om)).normalize();
        void n;
        pushArc(buf, hh.v3, endV, 0.2, col, 0.95, 0.22, false, 0.2 * side);
        pushArc(buf, hh.v3, endV, 0.3, col, 0.3, 0.06, false, 0.34 * side);
        idx.slice().sort((x, y) => hh.v3.dot((P[y] as GP).v3) - hh.v3.dot((P[x] as GP).v3)).slice(0, COAST_NEAR).forEach((k, j) => {
          pushArc(buf, hh.v3, (P[k] as GP).v3, 0.1, col, 0.34, 0.06, false, 0.1 * side * (j % 2 ? 1 : -1));
        });
      });
      // the concepts aimed at this hole land where their own text sits, not on the hole: a dashed arc shows which hole each one was written for
      if (state.layers.concepts && ov) {
        ov.concepts.forEach((cc, ci) => {
          if (cc.code !== hh.code || !mkC[ci]) return;
          pushArc(buf, hh.v3, (mkC[ci] as Mk).v3, 0.16, accC, cc.picked ? 0.7 : 0.4, cc.picked ? 0.35 : 0.16, true, 0.12);
        });
      }
      coastArcs = bufLines(buf, 0.9);
      scene.add(coastArcs);
    }
    const t = state.track;
    const tb = newBuf();
    t.nn.forEach(([k], j) => pushArc(tb, t.v3, (P[k] as GP).v3, 0.06, c(pal.star), 0.5, 0.18, false, 0.08 * (j % 2 ? 1 : -1)));
    trackArcs = bufLines(tb, 0.85);
    scene.add(trackArcs);
    rebuildPriorArcs();
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
      (flags[i] as THREE.Vector2).set(on ? 1 : 0, h.reg ? h.verdict : 4);
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
    mkGroupC.hidden = !L.concepts;
    mkGroupP.hidden = !L.prior;
    rebuildArcs();
    updateHoleFlags();
    mapDirty = true;
  }

  /* ------------------------------------------------ panels */
  const selbarEl = $<HTMLElement>('#gl-selbar');
  selbarEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="show"]')) stage.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  });
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

  /** cut at the last word boundary before max, so a description never ends mid-word */
  function truncWords(t: string, max: number): { head: string; cut: boolean } {
    if (t.length <= max) return { head: t, cut: false };
    const i = t.lastIndexOf(' ', max);
    return { head: t.slice(0, i > max * 0.6 ? i : max).replace(/[\s,;:.\-–—]+$/, ''), cut: true };
  }

  /** the one short status line for the callout on the globe; the long wording lives in the panel */
  function holeShort(g: GH): string {
    const r = g.h.replication;
    if (!g.reg) return 'Exploratory · not pre-registered';
    if (!r) return 'Candidate · not yet tested';
    if (g.verdict === 1) return `Refuted · ${r.observed_new} new report${r.observed_new === 1 ? '' : 's'} in the cell`;
    if (g.verdict === 2) return `Underpowered · E new ${fmtE(r.E_new)} < 2`;
    if (g.verdict === 3) return 'Replicated';
    return String(r.verdict);
  }

  function renderContact(): void {
    const t = state.track;
    const p = t.p;
    const s = srcLabel(p.s);
    const fullId = t.id.split('-');
    const lockId = `${(fullId[0] ?? '').slice(0, 3).toUpperCase()}-${fullId[fullId.length - 1]}`;
    const tr = truncWords(p.tx, 120);
    const body = tr.cut && !state.textOpen
      ? `${esc(tr.head)}… <button type="button" class="gl-more" data-act="more" aria-expanded="false">more</button>`
      : `${esc(p.tx)}${tr.cut ? ' <button type="button" class="gl-more" data-act="more" aria-expanded="true">less</button>' : ''}`;
    const nnRow = ([k, dg]: [number, number], i: number): string => `<button type="button" class="gl-nn" data-i="${k}" data-n="${i}"><span class="n">N${i + 1}</span><span class="t">${esc((P[k] as GP).p.t)}</span><span class="d">${dg.toFixed(2)}&deg;</span><i style="width:${Math.max(6, (1 - dg / 14) * 100).toFixed(0)}%"></i></button>`;
    const first = t.nn.slice(0, 3).map(nnRow).join('');
    const rest = t.nn.slice(3, 6);
    contactEl.innerHTML = `
      <div class="top2"><div class="gl-hd" style="flex:1"><b>Tracked contact</b><span class="sp"></span></div><span class="gl-lock"><i></i>${esc(lockId)} · LOCK</span></div>
      <div class="gl-ttl">${esc(p.t)}</div>
      <div class="gl-badges">${p.v ? '<span class="gl-badge v" title="' + esc(ytTitle) + '">VIDEO</span>' : ''}${t.isNew ? '<span class="gl-badge n" title="Gathered after the holes were registered, tagged blind">NEW SAMPLE</span>' : ''}${t.anchor ? '<span class="gl-badge" title="One of 84 representative tasks drawn from Anthropic’s usage reports, not one person’s report">REPRESENTATIVE TASK</span>' : ''}<span class="gl-badge">${esc(p.d)}</span></div>
      <div class="gl-body${state.textOpen ? ' open' : ''}">${body}</div>
      <div class="gl-src"><b>SOURCE</b><a href="${esc(safeHref(p.s))}" target="_blank" rel="noopener noreferrer">${s.html}</a>${s.t ? `<span style="flex:none;color:var(--g-star)">t=${esc(s.t)}</span>` : ''}</div>
      <div class="gl-chips"><div class="gl-chip"><small>MOVE</small><span title="${esc(p.mv)}">${esc(p.mv)}</span></div><div class="gl-chip"><small>MATERIAL</small><span title="${esc(p.mt)}">${esc(p.mt)}</span></div><div class="gl-chip"><small>AUDIENCE</small><span title="${esc(p.fr)}">${esc(p.fr)}</span></div></div>
      <div class="gl-nnh"><div class="gl-hd" style="flex:1"><b>Nearest contacts</b><span class="sp"></span></div><em>ANGLE ON THE GLOBE</em></div>
      <div id="gl-nnl">${first}${rest.length ? `<div class="gl-nn-more" ${state.nnAll ? '' : 'hidden'}>${rest.map((x, j) => nnRow(x, j + 3)).join('')}</div><button type="button" class="gl-nn-tg" data-act="nn-all" aria-expanded="${state.nnAll}">${state.nnAll ? 'Hide N4–N6' : `Show N4–N${t.nn.length}`}</button>` : ''}</div>`;
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
    const cs = state.layers.concepts && ov ? ov.concepts.filter((c) => c.code === g.code) : [];
    const concepts = cs.length
      ? `<div class="gl-hconc"><small>CONCEPTS AIMED HERE</small><div>${cs.map((c) => `<button type="button" class="gl-hc${c.picked ? ' pk' : ''}" data-c="${esc(c.id)}" title="${esc(c.title)}: show where it lands on the globe">${c.picked ? '★ ' + esc((c.name ?? 'Drift').toUpperCase()) : esc(c.id)}</button>`).join('')}</div></div>`
      : '';
    const metrics = g.reg && r
      ? `<div><small>E AT REG.</small><b class="a">${esc(fmtE(g.E))}</b><em>${data.meta.N_r1} reports</em></div><div><small>NEW</small><b>${r.observed_new}</b><em>E ${esc(fmtE(r.E_new))}</em></div><div><small>POOLED</small><b>${r.observed_pooled}</b><em>E ${esc(fmtE(r.E_pooled))}</em></div><div><small>q POOL</small><b>${esc(fmtQ(r.q_pooled))}</b><em>BH</em></div>`
      : `<div><small>EXPECTED</small><b class="a">${esc(fmtE(h.E))}</b><em>pooled</em></div><div><small>OBSERVED</small><b>${h.observed}</b><em>of ${fmtN(data.meta.N)}</em></div><div><small>P</small><b>${esc(fmtP(h.p))}</b><em>&nbsp;</em></div><div><small>q</small><b>${esc(fmtQ(h.q))}</b><em>BH</em></div>`;
    holecEl.innerHTML = `
      <div class="gl-hd"><b>Selected hole</b><span class="sp"></span><span class="m">${g.reg ? `${g.i + 1}/${nReg} registered` : 'exploratory'}</span></div>
      <div class="gl-hrow"><span class="gl-hcode">${esc(g.code)}</span><span class="gl-hcell">${esc(h.cell[a0] ?? '')}<span class="x">×</span>${esc(h.cell[a1] ?? '')}</span></div>
      <div class="gl-metrics">${metrics}</div>
      <div class="gl-stamp ${b.cls}"><i></i><span>${b.stamp}</span></div>
      ${concepts}
      <div class="gl-hfoot">Filaments n=${g.rowIdx.length} and n=${g.colIdx.length}, ${g.sep.toFixed(0)}° apart. Bootstrap ${esc(fmtF(g.reg ? (h.registered?.stability ?? h.stability) : h.stability, 2))}: share of resamples where it is still a hole (empty, E ≥ 2 in the resample).</div>
      <div class="gl-hlinks"><a href="#matrix" data-act="matrix">In the matrix</a><a href="catalog.html?hole=${esc(g.code)}">Its reports</a></div>`;
    selbarEl.innerHTML = `<span class="k">Selected</span><b>${esc(g.code)}</b><span class="n">${esc(h.cell[a0] ?? '')} × ${esc(h.cell[a1] ?? '')}</span><button type="button" class="gl-sb-go" data-act="show">Show on globe</button>`;
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
    const tg = e.target as HTMLElement;
    const act = tg.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'more') {
      state.textOpen = !state.textOpen;
      renderContact();
      return;
    }
    if (act === 'nn-all') {
      state.nnAll = !state.nnAll;
      renderContact();
      return;
    }
    const b = tg.closest<HTMLElement>('.gl-nn');
    if (b) {
      state.textOpen = false;
      selectPoint(P[Number(b.dataset.i)] as GP, true);
    }
  });
  contactEl.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.gl-nn');
    const n = b ? Number(b.dataset.n) : -1;
    if (n !== state.nnHover) { state.nnHover = n; wake(); }
  });
  contactEl.addEventListener('pointerleave', () => { if (state.nnHover !== -1) { state.nnHover = -1; wake(); } });
  catEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.gl-c');
    if (b) selectHole(Number(b.dataset.i), true, true);
  });
  holecEl.addEventListener('click', (e) => {
    const cb = (e.target as HTMLElement).closest<HTMLElement>('.gl-hc');
    if (cb) {
      focusConcept(cb.dataset.c ?? '');
      return;
    }
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-act="matrix"]');
    if (a) window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code: (H[state.hole] as GH).code, source: 'globe' } }));
  });

  /** where to look for a hole: the ring, with the tracked contact in view beside it */
  function frameFor(g: GH): THREE.Vector3 {
    const sum = g.v3.clone().add(state.track.v3);
    return sum.length() < 0.8 ? g.v3.clone() : sum.normalize();
  }
  function selectHole(i: number, fly: boolean, fromUser: boolean): void {
    if (!H[i]) return;
    state.hole = i;
    state.hover = -1;
    applySelection();
    const g = H[i] as GH;
    if (fly) {
      const m = frameFor(g);
      flyTo(vlat(m), vlon(m));
    }
    if (fromUser) {
      setHash(g.code);
      window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code: g.code, source: 'globe' } }));
    }
  }
  function selectPoint(p: GP, fly: boolean, user = true): void {
    state.track = p;
    state.textOpen = false;
    state.nnHover = -1;
    applySelection();
    if (fly) flyTo(p.lat, p.lon);
    if (user) setHash(`T-${p.id}`);
  }
  window.addEventListener(SELECT_EVENT, (ev) => {
    const d = (ev as CustomEvent<{ code?: string; source?: string }>).detail;
    if (!d?.code || d.source === 'globe') return;
    const g = holeByCode.get(d.code);
    if (g && g.i !== state.hole) selectHole(g.i, false, false);
  });
  function flyTo(lat: number, lon: number): void {
    const dl = ((lon - cam.lon + 540) % 360) - 180;
    cam.anim = { t0: performance.now(), dur: reduce ? 1 : 900, lat0: cam.lat, lon0: cam.lon, lat1: Math.max(-80, Math.min(80, lat)), dlon: dl };
    wake();
  }

  /* ------------------------------------------------ overlays: concepts (hollow stars), prior art (small markers), hover cards */
  const mksEl = $<HTMLElement>('.gl-mks');
  const mkGroupC = mksEl.querySelector<HTMLElement>('[data-g="c"]') as HTMLElement;
  const mkGroupP = mksEl.querySelector<HTMLElement>('[data-g="p"]') as HTMLElement;
  const cardEl = $<HTMLElement>('#gl-card');
  let ov: Overlays | null = null;
  interface Mk { v3: THREE.Vector3; el: HTMLElement; edge?: boolean; ex?: number; ey?: number; ex0?: number }
  let mkC: Mk[] = [];
  let mkP: Mk[] = [];
  const conceptIdx = new Map<string, number>();
  type MkRef = { k: 'c' | 'p' | 'l'; i: number };
  let cardRef: MkRef | null = null;
  let cardPinned = false;
  let cardW = 300;
  let cardH = 200;
  let hideT = 0;
  let paAll: THREE.LineSegments | null = null;
  let paHi: THREE.LineSegments | null = null;
  let hoverRef: MkRef | null = null;
  // concepts are diamonds (the picked one is filled and larger), prior art squares, pooled holes double rings: three shapes that cannot be mistaken for each other
  const STAR = '<svg viewBox="-12 -12 24 24" width="24" height="24" aria-hidden="true"><path d="M0-10L10 0L0 10L-10 0Z"/><path class="dot" d="M0-2.2L2.2 0L0 2.2L-2.2 0Z"/></svg>';
  const verdictName = (v: string): string => v.replace(/_/g, ' ');
  const vcls = (v: string): string => (v === 'done' ? 'done' : v === 'none_found' ? 'none' : 'part');

  function buildMarkers(): void {
    if (!ov) return;
    mkGroupC.innerHTML = '';
    mkGroupP.innerHTML = '';
    conceptIdx.clear();
    mkC = ov.concepts.map((c, i) => {
      conceptIdx.set(c.id, i);
      const e = document.createElement('div');
      e.className = `gl-mk gl-cs${c.picked ? ' pick' : ''}`;
      e.innerHTML = `${STAR}${c.picked ? `<span class="gl-mk-l">${esc((c.name ?? 'Drift').toUpperCase())} · PICKED</span>` : ''}`;
      mkGroupC.appendChild(e);
      return { v3: llv(c.lat, c.lon), el: e };
    });
    mkP = ov.prior_art.map((a) => {
      const e = document.createElement('div');
      e.className = 'gl-mk gl-ps';
      const sz = 10 + 6 * Math.max(0, Math.min(1, a.how_close));
      e.style.setProperty('--s', `${sz.toFixed(1)}px`);
      mkGroupP.appendChild(e);
      return { v3: llv(a.lat, a.lon), el: e };
    });
    const setCt = (k: string, n: number): void => {
      const e = layersEl.querySelector<HTMLElement>(`[data-k="${k}"] .ct`);
      if (e) e.textContent = String(n);
    };
    setCt('concepts', ov.concepts.length);
    setCt('prior', ov.prior_art.length);
  }

  /** thin arcs from each prior-art finding to the concepts it threatens; the hovered or pinned item's arcs are bright */
  function rebuildPriorArcs(): void {
    disposeLines(paAll);
    disposeLines(paHi);
    paAll = null;
    paHi = null;
    if (!ov || !state.layers.prior) return;
    const pal = palette();
    const col = pal.neg ? negOf(pal.ref) : new THREE.Color(pal.ref);
    const all = newBuf();
    const hi = newBuf();
    const ref = cardRef ?? hoverRef;
    ov.prior_art.forEach((a, ai) => {
      const av = (mkP[ai] as Mk).v3;
      a.threatens.forEach((cid) => {
        const ci = conceptIdx.get(cid);
        if (ci == null) return;
        const cv = (mkC[ci] as Mk).v3;
        const hot = !!ref && ((ref.k === 'p' && ref.i === ai) || (ref.k === 'c' && ref.i === ci));
        if (hot) pushArc(hi, av, cv, 0.14, col, 0.9, 0.5, false, 0.12);
        else pushArc(all, av, cv, 0.12, col, 0.26 * (0.4 + 0.6 * a.how_close), 0.08, false, 0.1);
      });
    });
    paAll = bufLines(all, 0.85);
    scene.add(paAll);
    if (hi.p.length) {
      paHi = bufLines(hi, 1);
      scene.add(paHi);
    }
  }

  function conceptCard(c: OvConcept): string {
    const hole = holeByCode.get(c.code);
    const pc = (v: number | null): string => (v == null ? '–' : `${Math.round(v)}<sup>th</sup>`);
    return `<div class="gl-cd-k"><span>CONCEPT · ${esc(c.id)}</span>${c.picked ? `<span class="gl-cd-pick">${esc((c.name ?? 'Drift').toUpperCase())} · PICKED</span>` : ''}<button type="button" class="gl-cd-x" aria-label="Close card">&times;</button></div>
      <h4>${esc(c.title)}</h4>
      <p>${esc(c.pitch)}</p>
      <div class="gl-cd-row"><small>PRIOR ART</small><span class="gl-pv ${vcls(c.prior_art_ai)}" title="Searched for AI projects doing this: ${esc(verdictName(c.prior_art_ai))}">AI · ${esc(verdictName(c.prior_art_ai))}</span><span class="gl-pv ${vcls(c.prior_art_product)}" title="Searched for products and tools doing this: ${esc(verdictName(c.prior_art_product))}">PRODUCT · ${esc(verdictName(c.prior_art_product))}</span></div>
      <div class="gl-cd-row" title="Emptier than the space around this share of existing reports (k-nearest-neighbour novelty on the corpus's own scale), under two unrelated embedding models"><small>LANDS</small><span class="gl-pc">bge <b>${pc(c.land.pct_bge)}</b></span><span class="gl-pc">nomic <b>${pc(c.land.pct_nomic)}</b></span><span class="gl-pc-n">percentile</span></div>
      <div class="gl-cd-row"><small>TARGET</small>${hole ? `<button type="button" class="gl-cd-hole" data-hole="${esc(c.code)}"><b>${esc(c.code)}</b> ${esc(cellLabel(hole.h))}</button>` : `<b>${esc(c.code)}</b>`}</div>
      ${c.picked ? '<div class="gl-cd-row"><a class="gl-cd-go" href="#built" data-go="built">See what was built &darr;</a></div>' : ''}`;
  }
  function priorCard(a: OvPrior, ai: number): string {
    const l = srcLabel(a.url);
    const thr = a.context.map((x) => `<span class="gl-pv ${vcls(x.verdict)}" title="${esc(x.lens)} search, concept ${esc(x.concept)}">${esc(x.concept)} · ${esc(x.lens)} · ${esc(verdictName(x.verdict))}</span>`).join('');
    return `<div class="gl-cd-k ref"><span>PRIOR ART · ${String(ai + 1).padStart(2, '0')}</span><button type="button" class="gl-cd-x" aria-label="Close card">&times;</button></div>
      <p class="what">${esc(a.what)}</p>
      <div class="gl-cd-row"><small>HOW CLOSE</small><span class="gl-cd-bar"><i style="width:${Math.round(a.how_close * 100)}%"></i></span><b>${a.how_close.toFixed(2)}</b><span class="gl-ai ${a.uses_ai ? 'y' : ''}">${a.uses_ai ? 'USES AI' : 'NO AI'}</span></div>
      <div class="gl-cd-row"><small>THREATENS</small>${thr || '–'}</div>
      <div class="gl-cd-row"><small>LINK</small><a href="${esc(safeHref(a.url))}" target="_blank" rel="noopener noreferrer">${l.html} &nearr;</a></div>`;
  }
  function liveCard(it: LivePlaced): string {
    const g = (l: string, x: LivePlaced['mv']): string => `<div class="gl-cd-row"><small>${l}</small><span>${esc(x.value ?? '–')}</span><b>${x.votes}/${x.of}</b></div>`;
    return `<div class="gl-cd-k live"><span>LIVE · HACKER NEWS</span><button type="button" class="gl-cd-x" aria-label="Close card">&times;</button></div>
      <h4>${esc(it.title)}</h4>
      ${g('MOVE', it.mv)}${g('MATERIAL', it.mt)}${g('FOR', it.fr)}
      <div class="gl-cd-row"><small>PLACED</small><span>confidence ${esc(it.conf)} (R ${it.R.toFixed(2)})</span></div>
      ${safeHref(it.url ?? '') ? `<div class="gl-cd-row"><small>LINK</small><a href="${esc(safeHref(it.url ?? ''))}" target="_blank" rel="noopener noreferrer">${srcLabel(it.url ?? '').html} &nearr;</a></div>` : ''}`;
  }

  function mkV3(r: MkRef): THREE.Vector3 | null {
    if (r.k === 'c') return mkC[r.i]?.v3 ?? null;
    if (r.k === 'p') return mkP[r.i]?.v3 ?? null;
    return comets[r.i]?.v3 ?? null;
  }
  function showCard(r: MkRef, pin: boolean): void {
    if (!ov && r.k !== 'l') return;
    window.clearTimeout(hideT);
    if (r.k === 'c') cardEl.innerHTML = conceptCard((ov as Overlays).concepts[r.i] as OvConcept);
    else if (r.k === 'p') cardEl.innerHTML = priorCard((ov as Overlays).prior_art[r.i] as OvPrior, r.i);
    else {
      const c = comets[r.i];
      if (!c) return;
      cardEl.innerHTML = liveCard(c.it);
    }
    cardEl.hidden = false;
    cardEl.dataset.k = r.k;
    cardEl.classList.toggle('pinned', pin);
    cardRef = r;
    cardPinned = pin;
    cardW = cardEl.offsetWidth || 300;
    cardH = cardEl.offsetHeight || 200;
    if (r.k === 'p' || r.k === 'c') rebuildPriorArcs();
    applyHot();
    wake();
  }
  function closeCard(): void {
    window.clearTimeout(hideT);
    if (!cardRef) return;
    const was = cardRef;
    cardRef = null;
    cardPinned = false;
    cardEl.hidden = true;
    cardEl.classList.remove('pinned');
    if (was.k !== 'l') rebuildPriorArcs();
    applyHot();
    liveCtl?.hover(null);
  }
  function scheduleHide(): void {
    window.clearTimeout(hideT);
    if (cardPinned) return;
    hideT = window.setTimeout(closeCard, 380);
  }
  cardEl.addEventListener('pointerenter', () => window.clearTimeout(hideT));
  cardEl.addEventListener('pointerleave', scheduleHide);
  cardEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.gl-cd-x')) {
      closeCard();
      return;
    }
    const hb = t.closest<HTMLElement>('[data-hole]');
    if (hb) {
      const g = holeByCode.get(hb.dataset.hole ?? '');
      if (g) selectHole(g.i, true, true);
      return;
    }
    if (t.closest('[data-go="built"]')) {
      e.preventDefault();
      scrollToBuilt();
    }
  });
  function scrollToBuilt(): void {
    const b = document.getElementById('built');
    if (b) b.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  /** a concept chosen from the hole panel: turn to it and pin its card */
  function focusConcept(id: string): void {
    const i = conceptIdx.get(id);
    const c = ov?.concepts[i ?? -1];
    if (i == null || !c) return;
    flyTo(c.lat, c.lon);
    showCard({ k: 'c', i }, true);
  }

  /* ------------------------------------------------ hole flash (LIVE found a possible filler) and the LIVE bridge */
  const flash = { i: -1, t0: -1e9 };
  function flashHole(code: string): void {
    const g = holeByCode.get(code);
    if (!g) return;
    flash.i = g.i;
    flash.t0 = performance.now();
    gU.uFlashI.value = g.i;
    if (g.v3.dot(camVec()) < 0.25) flyTo(g.lat, g.lon);
    wake();
  }
  let liveCtl: LiveCtl | null = null;
  const liveHost: LiveHost = {
    base: import.meta.env.BASE_URL,
    mount: el,
    lonlat: (id) => {
      const g = byId.get(id);
      return g ? [g.lat, g.lon] : undefined;
    },
    tags: (id) => appById.get(id),
    holes: H.map((g) => ({ code: g.code, axes: g.h.axes as [string, string], cell: g.h.cell, verdict: g.h.replication?.verdict })),
    setItems: (items) => {
      setComets(items);
      if (!items.length && cardRef?.k === 'l') closeCard();
    },
    flashHole,
    flyTo: (la, lo) => flyTo(la, lo),
    relayout: () => {
      resize();
      wake();
    },
    closed: () => syncLiveButton(false),
  };
  function syncLiveButton(on: boolean): void {
    state.layers.live = on;
    layersEl.querySelector('[data-k="live"]')?.setAttribute('aria-pressed', String(on));
    el.toggleAttribute('data-live', on);
    cometPts.visible = on && comets.length > 0;
    if (!on && cardRef?.k === 'l') closeCard();
  }
  async function setLive(on: boolean): Promise<void> {
    syncLiveButton(on);
    if (on) {
      if (!liveCtl) {
        try {
          const m = await import('./live');
          liveCtl = m.createLive(liveHost);
        } catch (err) {
          console.error('LIVE could not load', err);
          syncLiveButton(false);
          return;
        }
      }
      if (state.layers.live) liveCtl.setActive(true);
    } else liveCtl?.setActive(false);
    wake();
  }

  /* ------------------------------------------------ deep links: #OV-15 selects a hole, #T-<id> tracks an item (replaceState keeps history clean) */
  function setHash(tok: string): void {
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#${tok}`);
    } catch {
      /* no history API (sandboxed frame): the link just is not updated */
    }
  }
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    let moved = false;
    if (h.hole) {
      const g = holeByCode.get(h.hole);
      if (g && g.i !== state.hole) {
        selectHole(g.i, true, false);
        moved = true;
      }
    }
    if (h.track) {
      const p = byId.get(h.track);
      if (p && p !== state.track) {
        selectPoint(p, !h.hole, false);
        moved = true;
      }
    }
    if (moved && el.getBoundingClientRect().bottom < 120) el.scrollIntoView({ block: 'start' });
  });

  /* ------------------------------------------------ overlay labels */
  interface Lab { el: HTMLElement }
  let contL: (Lab & { c: GlobeFile['continents'][0]; v: THREE.Vector3 })[] = [];
  let holeL: (Lab & { g: GH })[] = [];
  let nnL: (Lab & { p: GP; i: number })[] = [];
  let vidL: (Lab & { p: GP })[] = [];
  let coastL: (Lab & { v: THREE.Vector3 })[] = [];
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
    nnL = state.track.nn.map(([k], i) => ({ p: P[k] as GP, i, el: mk('gl-nnl', `N${i + 1}`) }));
    const t = state.track;
    const fid = t.id.split('-');
    const lockId = `${(fid[0] ?? '').slice(0, 3).toUpperCase()}-${fid[fid.length - 1]}`;
    trkL = mk('gl-trk', `<div class="br"><i></i><i></i><i></i><i></i></div><div class="ln"></div><div class="id">${esc(lockId)}</div><div class="tx"><span class="l1">${esc(t.p.t)}</span><small>${t.lat >= 0 ? 'N' : 'S'}${Math.abs(t.lat).toFixed(2)} ${t.lon >= 0 ? 'E' : 'W'}${Math.abs(t.lon).toFixed(2)} · ${esc(t.p.d)} · locked</small></div>`);
    const h = H[state.hole];
    coastL = h
      ? ([[h.h.axes[0], h.rv, h.rowIdx.length, 'r'], [h.h.axes[1], h.cv, h.colIdx.length, 'c']] as [string, THREE.Vector3, number, string][]).map(([ax, v, n, cls]) => ({
        v, el: mk(`gl-lbl gl-coast ${cls}`, `<i></i><span><small>${cls === 'r' ? 'ROW' : 'COL'} · ${esc(ax)}</small>${esc(h.h.cell[ax] ?? '')} <em>n=${n}</em></span>`),
      }))
      : [];
    hcall = h ? mk('gl-call', `<div class="ln"></div><div class="tx"><span class="l1"><b>${esc(h.code)}</b> · ${esc(cellLabel(h.h))}</span><small>${esc(holeShort(h))}</small></div>`) : null;
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
  let userMoved = false;
  const tmpV = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  function proj(v3: THREE.Vector3, r = 1): { x: number; y: number } {
    tmpV.copy(v3).multiplyScalar(r).project(camera);
    return { x: (tmpV.x * 0.5 + 0.5) * W, y: (-tmpV.y * 0.5 + 0.5) * Hh };
  }
  const facing = (v3: THREE.Vector3): number => v3.dot(camVec()) * cam.base * cam.zoom - 1;
  let touchPick = false;
  function pickAt(mx: number, my: number): { p?: GP; h?: GH; m?: MkRef } {
    // markers first (concepts, prior art, LIVE comets), then reports, then hole rings
    let m: MkRef | undefined;
    let md = Infinity;
    const test = (k: MkRef['k'], i: number, v3: THREE.Vector3, rad: number, bias: number): void => {
      if (facing(v3) < 0.02) return;
      const sp = proj(v3, 1.01);
      const d = Math.hypot(sp.x - mx, sp.y - my) * bias;
      if (d < rad && d < md) { md = d; m = { k, i }; }
    };
    if (state.layers.concepts) {
      mkC.forEach((q, i) => {
        if (q.edge && q.ex != null && q.ey != null) {
          const d = Math.hypot((q.ex as number) - mx, (q.ey as number) - my) * 0.8;
          if (d < 22 && d < md) { md = d; m = { k: 'c', i }; }
        } else test('c', i, q.v3, ov?.concepts[i]?.picked ? 22 : 16, 0.8);
      });
    }
    if (state.layers.prior) mkP.forEach((q, i) => test('p', i, q.v3, 11, 1));
    if (state.layers.live && cometPts.visible) comets.forEach((c, i) => { if (c.landed) test('l', i, c.v3, 13, 0.9); });
    if (m) return { m };
    let best: GP | undefined;
    let bd = (touchPick ? 26 : 16) ** 2;
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
  const sameRef = (a: MkRef | null, b: MkRef | null): boolean => !!a && !!b && a.k === b.k && a.i === b.i;
  /** which markers are lit: the hovered or pinned one, and those it is linked to */
  function applyHot(): void {
    const ref = cardRef ?? hoverRef;
    mkC.forEach((q, i) => {
      const c = ov?.concepts[i];
      q.el.classList.toggle('hot', !!ref && !!c && ((ref.k === 'c' && ref.i === i) || (ref.k === 'p' && !!ov?.prior_art[ref.i]?.threatens.includes(c.id))));
    });
    mkP.forEach((q, i) => {
      q.el.classList.toggle('hot', !!ref && ((ref.k === 'p' && ref.i === i) || (ref.k === 'c' && !!ov?.prior_art[i]?.threatens.includes(ov?.concepts[ref.i]?.id ?? ''))));
    });
  }
  function setHover(m: MkRef | null): void {
    if (sameRef(m, hoverRef)) return;
    hoverRef = m;
    if (m?.k === 'l') liveCtl?.hover(comets[m.i]?.it.id ?? null);
    else if (hoverRef === null) liveCtl?.hover(null);
    rebuildPriorArcs();
    applyHot();
    wake();
  }
  function activate(m: MkRef): void {
    if (m.k === 'c' && ov?.concepts[m.i]?.picked) {
      scrollToBuilt();
      return;
    }
    showCard(m, true);
    applyHot();
    if (m.k === 'l') liveCtl?.select(comets[m.i]?.it.id ?? null);
  }
  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    touchPick = e.pointerType !== 'mouse';
    userMoved = true;
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
      const nh = r.p ? state.track.nn.findIndex(([k]) => k === (r.p as GP).i) : -1;
      if (nh !== state.nnHover) { state.nnHover = nh; wake(); }
      const hv = !r.m && !r.p && r.h ? r.h.i : -1;
      if (r.m) {
        setHover(r.m);
        window.clearTimeout(hideT);
        if (!cardPinned && !sameRef(cardRef, r.m)) showCard(r.m, false);
      } else {
        setHover(null);
        if (cardRef && !cardPinned) scheduleHide();
      }
      if (hv !== state.hover) {
        state.hover = hv;
        setKinds(hv >= 0 ? hv : state.hole);
        canvas.style.cursor = r.m || r.p || r.h ? 'pointer' : '';
        wake();
      } else canvas.style.cursor = r.m || r.p || r.h ? 'pointer' : '';
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (cardRef && !cardPinned) scheduleHide();
    setHover(null);
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
      if (r.m) activate(r.m);
      else if (r.p) selectPoint(r.p, false);
      else if (r.h) selectHole(r.h.i, false, true);
      else if (cardPinned) closeCard();
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
    if (key === 'Escape' && cardRef) { closeCard(); return; }
    if (m[key]) { setMode(m[key] as Mode); return; }
    if (key === 'h' || key === 'H') {
      selectHole((state.hole + 1) % nReg, true, true);
      return;
    }
    if ((key === 'n' || key === 'N') && state.track.nn.length) {
      const cur = state.nnHover >= 0 ? state.nnHover : -1;
      const nx = (cur + 1) % Math.min(6, state.track.nn.length);
      const k = (state.track.nn[nx] as [number, number])[0];
      selectPoint(P[k] as GP, true);
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
    const neg = palette().neg;
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
        if (neg) {
          // paper: cool ocean, slightly darker cool land, so the plate sits on the page instead of punching a black hole in it
          im.data[o] = land ? 196 - t * 26 : 236 - t * 14;
          im.data[o + 1] = land ? 206 - t * 26 : 241 - t * 14;
          im.data[o + 2] = land ? 222 - t * 26 : 248 - t * 12;
        } else {
          // night: land about 4:1 against the ocean (it was 1.6:1)
          im.data[o] = land ? 104 + t * 34 : 7 + t * 8;
          im.data[o + 1] = land ? 112 + t * 34 : 12 + t * 12;
          im.data[o + 2] = land ? 124 + t * 34 : 18 + t * 14;
        }
        im.data[o + 3] = 255;
      }
    }
    x.putImageData(im, 0, 0);
    x.strokeStyle = neg ? 'rgba(21,23,28,.10)' : 'rgba(214,220,227,.10)';
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
    mctx.drawImage(mapBase, 0, 0);
    const keyline = pal.neg ? 'rgba(245,247,250,.85)' : 'rgba(3,5,10,.8)';
    P.forEach((p) => {
      const s = p.p.v ? 4.4 : 2.6;
      mctx.globalAlpha = 1;
      mctx.fillStyle = keyline;
      mctx.fillRect(X(p.lon) - s / 2 - 0.8, Y(p.lat) - s / 2 - 0.8, s + 1.6, s + 1.6);
      mctx.fillStyle = state.layers.domains ? (pal.neg ? (FAM[p.fam] as FamilyDef).light : (FAM[p.fam] as FamilyDef).dark) : (pal.neg ? '#8A500E' : '#FFE8BE');
      mctx.globalAlpha = p.p.v ? 1 : 0.85;
      mctx.fillRect(X(p.lon) - s / 2, Y(p.lat) - s / 2, s, s);
    });
    mctx.globalAlpha = 1;
    const acc = pal.acc;
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
    mctx.strokeStyle = pal.neg ? '#8A500E' : '#FFE8BE';
    mctx.lineWidth = 1.5;
    mctx.strokeRect(X(t.lon) - 7, Y(t.lat) - 7, 14, 14);
    const d = cam.base * cam.zoom;
    const ang = Math.acos(1 / d);
    const la = cam.lat * D2R;
    const lo = cam.lon * D2R;
    mctx.strokeStyle = pal.neg ? 'rgba(21,23,28,.9)' : 'rgba(255,232,190,.85)';
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
    mctx.fillStyle = pal.neg ? 'rgba(21,23,28,.9)' : 'rgba(255,232,190,.9)';
    mctx.beginPath();
    mctx.arc(X(cam.lon), Y(cam.lat), 2.6, 0, 6.283);
    mctx.fill();
  }

  /* ------------------------------------------------ frame loop */
  let reduce = motionOff();
  const motBtn = $<HTMLButtonElement>('#gl-mot');
  const syncMotion = (): void => {
    reduce = motionOff();
    motBtn.textContent = reduce ? 'Motion off' : 'Motion on';
    motBtn.setAttribute('aria-pressed', String(reduce));
    motBtn.title = reduce ? 'Animation is off. Click to turn it on.' : 'Animation is on. Click to turn it off.';
    wake();
  };
  motBtn.addEventListener('click', () => setMotionOff(!reduce));
  window.addEventListener('overhang:motion', syncMotion);
  let visible = true;
  let running = false;
  let lastRender = 0;
  let frameMs = 16;
  let frames = 0;
  let dprQ = 1;
  let lastTelem = 0;
  const t0 = performance.now();
  const tLat = $<HTMLElement>('#gl-tlat');
  const tLon = $<HTMLElement>('#gl-tlon');
  const tAlt = $<HTMLElement>('#gl-talt');
  const tView = $<HTMLElement>('#gl-tview');
  const camPos = new THREE.Vector3();

  function resize(): void {
    measure();
    const bdpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(Math.min(bdpr, Math.max(1, bdpr * dprQ)));
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
    if (now - lastRender < 13) {
      requestAnimationFrame(frame);
      return;
    }
    // keep 60 fps on a mid laptop: when frames run long on a hi-dpi screen, step the pixel ratio down (never below 1, never above the cap of 2)
    const dt = Math.min(100, now - lastRender);
    lastRender = now;
    if (!reduce && !cam.anim) {
      frameMs = frameMs * 0.94 + dt * 0.06;
      if (++frames > 90 && frameMs > 24 && dprQ > 0.55 && Math.min(window.devicePixelRatio || 1, 2) > 1.01) {
        dprQ *= 0.82;
        frames = 0;
        frameMs = 16;
        resize();
      }
    }
    const t = reduce ? 0 : (now - t0) / 1000;
    {
      const fa = now - flash.t0;
      gU.uFlashA.value = fa >= 0 && fa < 2800 ? Math.max(0, 1 - fa / 2800) * (0.7 + 0.3 * Math.sin(fa / 170)) : 0;
    }
    if (comets.length && now < cmEnd) updateComets(now);
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
    const dsk = desktop;
    const gK = (v3: THREE.Vector3): number => (v3.dot(cv) - 1 / dist) / (1 - 1 / dist); // 0 at the horizon, 1 at the centre of the disc
    /** how much of a label at v3 survives the limb: none inside 12 px of the rim, fading in over the next stretch (grazing angles fade first) */
    const limbK = (v3: THREE.Vector3, sx: number, sy: number): number => {
      const rim = R - Math.hypot(sx - c.x, sy - c.y);
      if (rim < 12) return 0;
      return Math.max(0, Math.min(1, (gK(v3) - 0.05) / 0.25)) * Math.max(0, Math.min(1, (rim - 12) / 30));
    };

    if (L.concepts) {
      mkC.forEach((q, i) => {
        const f = facing(q.v3) > 0.03 ? Math.min(1, q.v3.dot(cv) * 3.2) : 0;
        q.edge = false;
        if (f > 0) {
          const s = proj(q.v3, 1.012);
          setT(q.el, s.x, s.y);
        } else if (ov?.concepts[i]?.picked && desktop) {
          // the picked concept stays on the screen even when it sits on the far side: it is pinned to the limb, pointing the way
          const perp = tmpB.copy(q.v3).addScaledVector(cv, -q.v3.dot(cv));
          if (perp.lengthSq() > 1e-6) {
            perp.normalize();
            tmpC.copy(cv).multiplyScalar(1 / dist).addScaledVector(perp, Math.sqrt(Math.max(0, 1 - 1 / (dist * dist))));
            const s = proj(tmpC, 1);
            q.edge = true;
            q.ex = s.x;
            q.ey = s.y;
            setT(q.el, s.x, s.y);
            q.el.classList.toggle('edge-l', s.x > c.x);
          }
        }
        q.el.classList.toggle('edge', !!q.edge);
        q.el.style.opacity = q.edge ? '0.9' : String(f);
      });
    }
    if (L.prior) {
      mkP.forEach((q, i) => {
        const f = facing(q.v3) > 0.03 ? Math.min(1, q.v3.dot(cv) * 3.2) : 0;
        q.el.style.opacity = String(f * (0.5 + 0.5 * ((ov?.prior_art[i]?.how_close ?? 0.5))));
        if (f > 0) { const s = proj(q.v3, 1.01); setT(q.el, s.x, s.y); }
      });
    }
    if (cardRef && !cardEl.hidden) {
      const v = mkV3(cardRef);
      const layerOn = cardRef.k === 'c' ? L.concepts : cardRef.k === 'p' ? L.prior : L.live;
      const em = cardRef.k === 'c' ? mkC[cardRef.i] : undefined;
      if (!v || !layerOn || (facing(v) < 0.03 && !em?.edge)) cardEl.style.opacity = '0';
      else {
        const s = em?.edge ? { x: em.ex as number, y: em.ey as number } : proj(v, 1.01);
        let x = s.x + 24;
        let y = s.y - 22;
        if (x + cardW > view.x1) x = s.x - 24 - cardW;
        x = Math.max(view.x0 + 2, Math.min(W - cardW - 6, x));
        y = Math.max(6, Math.min(Hh - cardH - 6, y));
        cardEl.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
        cardEl.style.opacity = '1';
      }
    }
    // ---- labels: greedy placement. Candidates are ranked, each tries its positions in turn, and a label that would overprint one already placed stays hidden.
    {
      interface Box { x: number; y: number; w: number; h: number }
      interface Opt extends Box { apply: () => void }
      interface Cand { prio: number; op: number; el: HTMLElement; opts: Opt[]; kind?: string }
      const cands: Cand[] = [];
      const placed: Box[] = [];
      const inFree = (b: Box): boolean => b.x >= view.x0 - 2 && b.x + b.w <= view.x1 + 2 && b.y >= view.y0 - 2 && b.y + b.h <= view.y1 + 2;
      /** a box whose four corners all lie inside the globe's disc, a few px off the rim */
      const inDisk = (b: Box): boolean => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].every(([px, py]) => Math.hypot((px as number) - c.x, (py as number) - c.y) <= R - 6);
      /** pull a box of width w sideways into the free stage, so a callout is never cut off by a rail */
      const cx = (x: number, w: number): number => Math.max(view.x0 + 2, Math.min(view.x1 - 2 - w, x));
      const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w + 3 && a.x + a.w + 3 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y;
      const sh = H[state.hole];
      const tp = state.track;
      const tfac = facing(tp.v3);
      const ts = proj(tp.v3, 1.008);
      // things already drawn that a label must not sit on: the tracked bracket and the selected ring's centre
      placed.push({ x: ts.x - 18, y: ts.y - 18, w: 36, h: 36 });
      let hs: { x: number; y: number } | null = null;
      if (sh && facing(sh.v3) > 0.04) hs = proj(sh.v3, 1);
      // markers already on the plot: concept diamonds and prior-art squares
      mkC.forEach((q) => { if (L.concepts && parseFloat(q.el.style.opacity || '0') > 0.1) { const s = q.edge ? { x: q.ex as number, y: q.ey as number } : proj(q.v3, 1.012); placed.push({ x: s.x - 13, y: s.y - 13, w: 26, h: 26 }); } });
      mkP.forEach((q) => { if (L.prior && parseFloat(q.el.style.opacity || '0') > 0.1) { const s = proj(q.v3, 1.01); placed.push({ x: s.x - 8, y: s.y - 8, w: 16, h: 16 }); } });
      // the picked concept's own label (a marker, positioned above) counts as taken
      mkC.forEach((q, i) => {
        if (!L.concepts || !ov?.concepts[i]?.picked) return;
        const op = parseFloat(q.el.style.opacity || '0');
        if (op < 0.1) return;
        const s = q.edge ? { x: q.ex as number, y: q.ey as number } : proj(q.v3, 1.012);
        const w = 176;
        placed.push({ x: q.el.classList.contains('edge-l') ? s.x - 32 - w : s.x + 30, y: s.y - 10, w, h: 22 });
      });

      // 1. the tracked contact: two lines, on the first side that is free and inside the stage
      if (trkL) {
        const tx = trkL.querySelector<HTMLElement>('.tx') as HTMLElement;
        const ln = trkL.querySelector<HTMLElement>('.ln') as HTMLElement;
        const idl = trkL.querySelector<HTMLElement>('.id') as HTMLElement;
        const br = trkL.querySelector<HTMLElement>('.br') as HTMLElement;
        const k = tfac > 0.03 ? limbK(tp.v3, ts.x, ts.y) : 0;
        br.style.transform = `scale(${(1 + 0.07 * Math.sin(t * 3.2)).toFixed(3)}) rotate(${(Math.sin(t * 0.8) * 4).toFixed(2)}deg)`;
        trkL.style.transform = `translate(${ts.x.toFixed(1)}px,${ts.y.toFixed(1)}px)`;
        trkL.style.opacity = tfac > 0.03 ? String(Math.max(0.4, k)) : '0';
        idl.style.display = dsk ? 'none' : '';
        tx.style.display = dsk ? '' : 'none';
        ln.style.display = dsk ? '' : 'none';
        if (dsk && tfac > 0.03) {
          const W = Math.min(250, view.x1 - view.x0 - 8);
          const opts: Opt[] = [];
          for (const [sx, sy] of [[1, -1], [-1, -1], [1, 1], [-1, 1]] as [number, number][]) {
            const dx = sx * 58;
            const dy = sy * 62;
            const bx = cx(sx > 0 ? ts.x + dx + 8 : ts.x + dx - 8 - W, W);
            const by = sy < 0 ? ts.y + dy - 22 : ts.y + dy + 4;
            opts.push({
              x: bx, y: by, w: W, h: 34,
              apply: () => {
                ln.style.width = `${Math.hypot(dx, dy) - 18}px`;
                ln.style.transform = `translate(${dx > 0 ? 10 : -10}px,${dy < 0 ? -10 : 10}px) rotate(${Math.atan2(dy + (dy < 0 ? 10 : -10), dx + (dx > 0 ? -10 : 10))}rad)`;
                tx.style.width = `${W}px`;
                tx.style.transform = `translate(${bx - ts.x}px,${by - ts.y}px)`;
                tx.style.textAlign = bx >= ts.x ? 'left' : 'right';
              },
            });
          }
          const pick = opts.find((o) => inFree(o) && inDisk(o) && !placed.slice(1).some((q) => hit(o, q))) ?? opts.find((o) => inFree(o) && !placed.slice(1).some((q) => hit(o, q))) ?? opts.find(inFree) ?? opts[0];
          if (pick) { pick.apply(); placed.push(pick); }
        }
      }

      // 2. the selected hole's callout (two lines)
      if (hcall) {
        const ln = hcall.querySelector<HTMLElement>('.ln') as HTMLElement;
        const txEl = hcall.querySelector<HTMLElement>('.tx') as HTMLElement;
        hcall.style.opacity = '0';
        if (sh && hs && dsk) {
          const s2 = proj(llv(sh.lat + sh.rad / D2R, sh.lon), 1);
          const rpx = Math.hypot(s2.x - hs.x, s2.y - hs.y);
          const W = Math.min(236, view.x1 - view.x0 - 8);
          const opts: Opt[] = [];
          for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as [number, number][]) {
            const ex = hs.x + sx * rpx * 0.74;
            const ey = hs.y + sy * rpx * 0.74;
            const tx2 = ex + sx * 28;
            const ty = ey + sy * 24;
            const bx = cx(sx > 0 ? tx2 + 7 : tx2 - 7 - W, W);
            const by = sy > 0 ? ty - 6 : ty - 44;
            opts.push({
              x: bx, y: by, w: W, h: 48,
              apply: () => {
                ln.style.width = `${Math.hypot(tx2 - ex, ty - ey)}px`;
                ln.style.transform = `translate(${ex}px,${ey}px) rotate(${Math.atan2(ty - ey, tx2 - ex)}rad)`;
                txEl.style.width = `${W}px`;
                txEl.style.transform = `translate(${bx}px,${by}px)`;
                txEl.style.textAlign = bx >= tx2 ? 'left' : 'right';
              },
            });
          }
          const k = limbK(sh.v3, hs.x, hs.y);
          // inside the disc and clear of everything first; then clear of everything inside the stage; then anywhere in the stage
          const pick = opts.find((o) => inFree(o) && inDisk(o) && !placed.some((q) => hit(o, q))) ?? opts.find((o) => inFree(o) && !placed.some((q) => hit(o, q))) ?? opts.find(inFree) ?? opts[0];
          if (pick && k > 0.05) { pick.apply(); placed.push(pick); hcall.style.opacity = String(Math.min(1, k * 1.2)); }
        }
      }

      // 3. ring codes, coast labels, continent labels, nearest contacts, report titles: ranked candidates
      const holeOn = (g: GH): boolean => (g.reg ? L.holes : L.pooled) || g === sh;
      const shown = H[state.hover >= 0 ? state.hover : state.hole];
      holeL.forEach((o) => {
        const g = o.g;
        const isSel = g === sh;
        o.el.style.opacity = '0';
        if (!holeOn(g) || facing(g.v3) <= 0) return;
        if (!dsk && !isSel) return; // phones: only the selected code stays on the plot
        const s = proj(g.v3, 1);
        const k = limbK(g.v3, s.x, s.y);
        if (k <= 0.02) return;
        o.el.classList.toggle('sel', isSel);
        const rr = g.rad / D2R;
        const e = proj(llv(g.lat - rr * 0.72, g.lon + (rr * 0.72) / Math.max(0.3, Math.cos(g.lat * D2R))), 1);
        const x = isSel ? s.x : e.x;
        const y = isSel ? s.y : e.y;
        const place = (cls: string, bx: number, by: number): Opt => ({ x: bx, y: by, w: 46, h: 13, apply: () => { o.el.classList.remove('f-l', 'f-u', 'f-d'); if (cls) o.el.classList.add(cls); setT(o.el, x, y); } });
        // the selected ring's code tries right, left, above, below: it may not sit on the tracked bracket or on a callout
        const opts = isSel ? [place('', x + 8, y - 6), place('f-l', x - 55, y - 6), place('f-d', x - 16, y + 7), place('f-u', x - 16, y - 21)] : [place('', x, y - 6)];
        cands.push({ prio: isSel ? 90 : g === shown ? 85 : 70, op: Math.min(1, k * 1.4) * (isSel || g === shown ? 1 : 0.85), el: o.el, opts, kind: 'hole' });
      });
      coastL.forEach((o) => {
        o.el.style.opacity = '0';
        if (!dsk || facing(o.v) <= 0.04) return;
        const s = proj(o.v, 1.008);
        const k = limbK(o.v, s.x, s.y);
        if (k <= 0.02) return;
        cands.push({ prio: 80, op: Math.min(1, k * 1.4), el: o.el, opts: [{ x: s.x + 10, y: s.y - 8, w: 184, h: 34, apply: () => setT(o.el, s.x, s.y) }] });
      });
      // continent labels are dropped while a hole is selected (one always is); a row hovered in the left rail shows its own
      contL.forEach((o, i) => {
        o.el.style.opacity = '0';
        if (!dsk || !L.domains || state.contHover !== i) return;
        const s = proj(o.v, 1);
        const k = limbK(o.v, s.x, s.y);
        if (k <= 0.02) return;
        const w = o.el.offsetWidth || 160;
        cands.push({ prio: 100, op: Math.min(1, k * 1.6), el: o.el, opts: [{ x: s.x - w / 2, y: s.y - 12, w, h: 28, apply: () => setT(o.el, s.x - w / 2, s.y - 12) }] });
      });
      // nearest contacts: N1 to N3 as numbers pushed radially away from the tracked star, N4 to N6 only while hovered
      nnL.forEach((o) => {
        o.el.style.opacity = '0';
        if (!dsk) return;
        if (o.i >= 3 && state.nnHover !== o.i) return;
        if (facing(o.p.v3) < 0.05) return;
        const s = proj(o.p.v3, 1.008);
        const dxv = s.x - ts.x;
        const dyv = s.y - ts.y;
        const dd = Math.hypot(dxv, dyv);
        if (dd < 7) return;
        const k = limbK(o.p.v3, s.x, s.y);
        if (k <= 0.02) return;
        const ox = s.x + (dxv / dd) * 11 - (dxv < 0 ? 16 : 0);
        const oy = s.y + (dyv / dd) * 11 - 5;
        cands.push({ prio: o.i === state.nnHover ? 95 : 50 - o.i, op: Math.min(1, k * 1.5), el: o.el, opts: [{ x: ox, y: oy, w: 16, h: 11, apply: () => setT(o.el, ox, oy) }], kind: 'nn' });
      });
      vidL.forEach((o) => {
        o.el.style.opacity = '0';
        if (!dsk || !L.video) return;
        const f = facing(o.p.v3);
        if (f < 0.2 || gK(o.p.v3) < 0.4) return; // titles sit well inside the disc, never on the dense rim
        const s = proj(o.p.v3, 1.008);
        const k = limbK(o.p.v3, s.x, s.y);
        if (k <= 0.05) return;
        const w = o.el.offsetWidth || 120;
        cands.push({ prio: 30 + f, op: Math.min(0.9, f * 3) * 0.9 * Math.min(1, k * 1.5), el: o.el, opts: [{ x: s.x + 10, y: s.y - 12, w: w + 10, h: 24, apply: () => setT(o.el, s.x + 10, s.y - 4) }], kind: 'vid' });
      });

      cands.sort((a, b) => b.prio - a.prio);
      let nVid = 0;
      for (const cnd of cands) {
        if (cnd.kind === 'vid' && nVid >= 3) continue;
        const o = cnd.opts.find((q) => inFree(q) && (cnd.kind !== 'vid' || inDisk(q)) && !placed.some((r) => hit(q, r)));
        if (!o) continue;
        o.apply();
        cnd.el.style.opacity = String(cnd.op);
        placed.push(o);
        if (cnd.kind === 'vid') nVid++;
      }
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
  syncMotion();
  // start looking at the selected hole with the more populated of its two filaments beside it (a continent, not a pole), the tracked contact a little in view
  {
    const hh0 = H[state.hole] as GH;
    if (storyDefault && hh0.v3.dot(state.track.v3) > -0.5) {
      // the default story: centre between the OV-15 ring and the tracked contact so both sit inside the limb; the picked concept (Drift) is on the far side
      // and shows as the marker pinned to the limb. The latitude may go far south: the ring and the contact are on opposite sides of the pole.
      const m = hh0.v3.clone().add(state.track.v3).normalize();
      cam.lat = Math.max(-82, Math.min(82, vlat(m)));
      cam.lon = vlon(m);
    } else {
      const big = hh0.colIdx.length >= hh0.rowIdx.length ? hh0.cv : hh0.rv;
      let m = hh0.v3.clone().add(big);
      m = m.length() < 0.3 ? hh0.v3.clone() : m.normalize();
      m = m.multiplyScalar(0.82).add(state.track.v3.clone().multiplyScalar(0.18)).normalize();
      cam.lat = Math.max(-40, Math.min(40, vlat(m)));
      cam.lon = vlon(m);
    }
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

  // concepts and prior art: fetched after the first frame, so the globe never waits for them
  const camQ = (qs.get('cam') ?? '').split(',').filter((x) => x.trim() !== '').map(Number).filter((x) => Number.isFinite(x));
  if (camQ.length >= 2) {
    cam.lat = Math.max(-82, Math.min(82, camQ[0] as number));
    cam.lon = camQ[1] as number;
    if (camQ[2]) cam.zoom = Math.max(0.42, Math.min(1.5, camQ[2]));
  }
  fetch(`${import.meta.env.BASE_URL}data/overlays.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Overlays>) : Promise.reject(new Error(`overlays.json ${r.status}`))))
    .then((o) => {
      ov = o;
      buildMarkers();
      applyLayers();
      rebuildArcs();
      renderHole();
      const pin = qs.get('pin');
      if (pin) {
        const pr = /^prior:(\d+)$/.exec(pin);
        if (pr && o.prior_art[Number(pr[1])]) showCard({ k: 'p', i: Number(pr[1]) }, true);
        else if (conceptIdx.has(pin)) showCard({ k: 'c', i: conceptIdx.get(pin) as number }, true);
      }
      wake();
    })
    .catch((err) => {
      console.warn('overlays.json is not available: concepts and prior art stay empty', err);
      layersEl.querySelectorAll('[data-k="concepts"] .ct, [data-k="prior"] .ct').forEach((e) => (e.textContent = '–'));
    });
  if (state.layers.live) void setLive(true);
  if (import.meta.env.DEV) {
    // the dev-only check of the LIVE recipe against the cases in live_index.json (runs once; the result goes to the console)
    void import('./live').then((m) => m.runSelftest(import.meta.env.BASE_URL, liveHost.lonlat, liveHost.tags)).catch((e) => console.error('live selftest could not run', e));
  }

  // a small hook for the page's own checks and screenshots
  (window as unknown as { __globe?: unknown }).__globe = {
    select: (code: string) => { const g = holeByCode.get(code); if (g) selectHole(g.i, true, false); },
    mode: (m: Mode) => setMode(m),
    live: (on: boolean) => setLive(on),
    cam,
    state,
  };
  return true;
}

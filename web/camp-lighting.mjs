import { hash2 } from './camp-terrain.mjs';

export function materialGrain() {
  const pixels=new Uint8Array(64*64);
  for (let y=0;y<64;y++) for(let x=0;x<64;x++) {
    const wood=y<32;
    const line=wood?Math.sin(y*1.29+Math.sin(x*.13)*.85):Math.sin(y*2.43+x*.035);
    const pores=hash2(x,wood?Math.floor(y/2):y,811);
    pixels[y*64+x]=Math.round(130+line*(wood?36:22)+(pores-.5)*52);
  }
  return pixels;
}

const cached=new WeakMap();
const ring=Array.from({length:9},(_,i)=>[Math.cos(i*Math.PI/4),Math.sin(i*Math.PI/4)]);

export function contactShadowMesh({source,x,z,height},sun) {
  if (sun.phase==='夜晚' || !sun.direct) return new Float32Array();
  const quantize=n=>Math.round(n*12);
  const heading=sun.sunVector, key=[Math.floor(x/2),Math.floor(z/2),...heading.map(quantize),quantize(sun.direct)].join(',');
  const old=cached.get(source);
  if (old?.key===key) return old.mesh;
  const out=[];
  const put=(p,a)=>out.push(...p,a,0,0,0,0,0,0,0,0,1,0,.5);
  for (const b of source) {
    if (b.x>x+21 || b.x+b.w<x-21 || b.z>z+21 || b.z+b.d<z-21) continue;
    const shift=Math.min(1.25,(1-heading[1])*.95);
    const cx=b.x+b.w/2-heading[0]*shift,cz=b.z+b.d/2-heading[2]*shift;
    const rx=b.w/2+.37+Math.abs(heading[0])*shift*.42,rz=b.d/2+.32+Math.abs(heading[2])*shift*.42;
    const ground=(px,pz)=>[px,height(px,pz)+.034,pz];
    const center=ground(cx,cz), alpha=.12+sun.direct*.30;
    const edge=ring.map(([u,v])=>ground(cx+u*rx,cz+v*rz));
    for(let i=0;i<8;i++) {
      put(center,alpha);put(edge[i],0);put(edge[i+1],0);
    }
  }
  const mesh=new Float32Array(out);
  cached.set(source,{key,mesh});
  return mesh;
}

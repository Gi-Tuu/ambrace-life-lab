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

const contactCache=new WeakMap();
export function groundContactMesh({source,x,z,height}) {
  const key=[Math.floor(x/2),Math.floor(z/2)].join(',');
  const old=contactCache.get(source);
  if (old?.key===key) return old.mesh;
  const out=[];
  const emit=(px,pz,alpha)=>out.push(px,height(px,pz)+.024,pz,alpha,0,0,0,0,0,0,0,0,1,0,.5);
  for (const box of source) {
    const cx=box.x+box.w*.5,cz=box.z+box.d*.5;
    if (Math.abs(cx-x)>20+box.w*.5 || Math.abs(cz-z)>20+box.d*.5) continue;
    if (box.y-height(cx,cz)>.18 || box.y+box.h<height(cx,cz)-.08) continue;
    const rx=box.w*.5, rz=box.d*.5;
    const corners=[[-1,-1],[1,-1],[1,1],[-1,1]];
    for (let i=0;i<corners.length;i++) {
      const [u,v]=corners[i],[a,b]=corners[(i+1)%corners.length];
      const [ix,iz]=[cx+u*(rx+.015),cz+v*(rz+.015)];
      const [jx,jz]=[cx+a*(rx+.015),cz+b*(rz+.015)];
      const [ox,oz]=[cx+u*(rx+.23),cz+v*(rz+.21)];
      const [px,pz]=[cx+a*(rx+.23),cz+b*(rz+.21)];
      emit(ix,iz,.34);emit(jx,jz,.34);emit(px,pz,0);
      emit(ix,iz,.34);emit(px,pz,0);emit(ox,oz,0);
    }
  }
  const mesh=new Float32Array(out);
  contactCache.set(source,{key,mesh});
  return mesh;
}

export function roomExposure(open,daylight,fire=0) {
  return open ? .92 : .49+.18*daylight+.21*fire;
}

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
    const cx=b.x+b.w/2,cz=b.z+b.d/2, groundY=height(cx,cz);
    const slope=1/Math.max(heading[1],.28);
    const bottom=Math.min(5,Math.max(0,b.y-groundY)*slope);
    const top=Math.min(5,Math.max(0,b.y+b.h-groundY)*slope);
    const middle=(bottom+top)/2;
    const rx=b.w/2+.24, rz=b.d/2+.21;
    const ground=(px,pz)=>[px,height(px,pz)+.034,pz];
    const center=ground(cx-heading[0]*middle,cz-heading[2]*middle);
    const alpha=.10+sun.direct*.25;
    const edge=ring.map(([u,v])=>{
      const end=u*heading[0]+v*heading[2]<0 ? top : bottom;
      return ground(cx+u*rx-heading[0]*end,cz+v*rz-heading[2]*end);
    });
    for(let i=0;i<8;i++) {
      put(center,alpha);put(edge[i],0);put(edge[i+1],0);
    }
  }
  const mesh=new Float32Array(out);
  cached.set(source,{key,mesh});
  return mesh;
}

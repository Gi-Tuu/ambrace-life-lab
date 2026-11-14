import { rayBox } from './camp-3d-render.mjs';

const CELL=.5, BIN=2;

function heightSampler(height) {
  const samples=new Map();
  return (x,z)=>{
    const ix=Math.floor(x), iz=Math.floor(z), u=x-ix, v=z-iz;
    const at=(px,pz)=>{
      const key=px+','+pz;
      if (!samples.has(key)) {
        if (samples.size>=4096) samples.clear();
        samples.set(key,height(px,pz));
      }
      return samples.get(key);
    };
    const a=at(ix,iz), c=at(ix+1,iz+1);
    return u>=v ? a+(at(ix+1,iz)-a)*(u-v)+(c-a)*v
      : a+(at(ix,iz+1)-a)*(v-u)+(c-a)*u;
  };
}

export function sightScene(height, lists) {
  const bins=new Map();
  for (const boxes of lists) for (const b of boxes) {
    if ((!b.occluder && !b.solid) || b.fx || b.h<.22 || b.w*b.d<.025) continue;
    // Include adjacent bins a quarter-tile ray step can skip at a corner.
    const pad=.25+(b.yaw?Math.hypot(b.w,b.d):0);
    for (let z=Math.floor((b.z-pad)/BIN);z<=Math.floor((b.z+b.d+pad)/BIN);z++) {
      for (let x=Math.floor((b.x-pad)/BIN);x<=Math.floor((b.x+b.w+pad)/BIN);x++) {
        const key=x+','+z;
        if (!bins.has(key)) bins.set(key,[]);
        bins.get(key).push(b);
      }
    }
  }
  const ground=heightSampler(height);
  const clear=(from,to,ownModel)=>{
    const dx=to[0]-from[0], dy=to[1]-from[1], dz=to[2]-from[2], ray=[dx,dy,dz];
    const distance=Math.hypot(dx,dz);
    if (distance<.24) return true;
    const steps=Math.ceil(distance*4), end=1-.16/distance;
    let lastBin;
    for (let i=0;i<steps;i++) {
      const t=i/steps, x=from[0]+dx*t, z=from[2]+dz*t;
      if (t>=end) break;
      if (i>0 && ground(x,z)>from[1]+dy*t+.09) return false;
      const key=Math.floor(x/BIN)+','+Math.floor(z/BIN);
      if (key===lastBin) continue;
      lastBin=key;
      for (const b of bins.get(key)??[]) {
        if (ownModel && b.occluder===ownModel) continue;
        const hit=rayBox(from,ray,b);
        if (hit!==null && hit<end) return false;
      }
    }
    return true;
  };
  return {height,clear};
}

export function campSight(scene,x,z,radius) {
  const from=[x,scene.height(x,z)+1.32,z], limit=radius+.45;
  const size=Math.ceil((limit+1)/CELL)*2+1;
  const origin=[x-(size-1)*CELL/2-CELL/2,z-(size-1)*CELL/2-CELL/2];
  const bytes=new Uint8Array(size*size);
  for (let row=0;row<size;row++) for (let col=0;col<size;col++) {
    const px=origin[0]+(col+.5)*CELL, pz=origin[1]+(row+.5)*CELL;
    if (Math.hypot(px-x,pz-z)<=limit+.4 &&
        scene.clear(from,[px,scene.height(px,pz)+.43,pz])) bytes[row*size+col]=255;
  }
  return {origin,size,extent:size*CELL,bytes,
    sees(px,pz,y=scene.height(px,pz)+.65,ownModel) {
      return Math.hypot(px-x,pz-z)<=limit && scene.clear(from,[px,y,pz],ownModel);
    },
  };
}

// Orthographic picking uses the same terrain surface as the ground mesh.
export function terrainHit(origin,ray,height,limit) {
  const step=.25/Math.max(Math.abs(ray[0]),Math.abs(ray[2]),Math.abs(ray[1]));
  for (let t=0;t<=limit;t+=step) {
    const x=origin[0]+ray[0]*t,z=origin[2]+ray[2]*t;
    if (origin[1]+ray[1]*t<height(x,z)) return t;
  }
  return Infinity;
}

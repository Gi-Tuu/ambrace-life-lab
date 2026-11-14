import { campHash, campTerrain, hash2, reliefAt } from './camp-terrain.mjs';
import { TOWN_SIZE } from './camp-layout.mjs';
import { wildVegetation } from './camp-3d-scene.mjs';

export const REGION_SIZE=24;
export const WILDS=Object.freeze({west:-240,east:TOWN_SIZE.width+240,north:-220,south:TOWN_SIZE.depth+270});
const {west,east,north,south}=WILDS;
const WORLD_FLOOR=-29;
export const inCamp=(x,z)=>x>=0 && x<TOWN_SIZE.width && z>=0 && z<TOWN_SIZE.depth;

const smooth=(a,b,v)=>{
  const t=Math.max(0,Math.min(1,(v-a)/(b-a)));
  return t*t*(3-2*t);
};
const mix=(a,b,t)=>a+(b-a)*t;
function noise(seed,x,z,scale) {
  const px=x/scale,pz=z/scale,ix=Math.floor(px),iz=Math.floor(pz);
  const u=smooth(0,1,px-ix),v=smooth(0,1,pz-iz);
  return mix(mix(hash2(ix,iz,seed),hash2(ix+1,iz,seed),u),
    mix(hash2(ix,iz+1,seed),hash2(ix+1,iz+1,seed),u),v);
}

export function forestDensity(seed,x,z) {
  const forest=noise(seed+27,x,z,40)*.73+noise(seed+28,x,z,13)*.27;
  return mix(.026,.41,smooth(.31,.76,forest));
}

export function wildLandscape(seed,version,{joined=false, flats=[], hills=[], roadDistance}={}) {
  const {riverCenter,riverHalfWidth}=campTerrain(seed,false,version);
  const phase=campHash(seed,'wilds')*Math.PI*2;
  const beyond=z=>smooth(0,44,Math.max(0,-z,z-TOWN_SIZE.depth));
  const width=z=>mix(riverHalfWidth(z*16)/16,1.1+noise(seed+31,0,z,29)*1.65,beyond(z));
  const river=z=>riverCenter(z*16)/16+(noise(seed+29,0,z,57)-.5)*32*beyond(z);
  const source=-191, junction=-96, branchSource=source+2;
  const sideWidth=z=>.88*smooth(branchSource,branchSource+5,z);
  const sourceWidth=z=>width(z)*smooth(source,source+5,z);
  const sideStream=z=>river(z)-(.43*(junction-z)+3*Math.sin((junction-z)*.15));
  const southEdge=x=>296+17*Math.sin(x*.057+phase)+4*Math.sin(x*.16+phase*2);
  const northEdge=x=>-199+16*Math.sin(x*.062+phase)+4*Math.cos(x*.14);
  const westEdge=z=>-214+15*Math.sin(z*.063+phase)+3*Math.sin(z*.17);
  const eastEdge=z=>336+17*Math.sin(z*.058+phase)-4*Math.cos(z*.15);
  const rim=(x,z)=>Math.min(z-northEdge(x),x-westEdge(z),eastEdge(z)-x);
  const land=(x,z)=>southEdge(x)-z;
  const bankGap=(x,z)=> {
    if (z<source || land(x,z)<0) return 5;
    const main=sourceWidth(z)-Math.abs(x-river(z));
    const branch=z>=branchSource && z<=junction ? sideWidth(z)-Math.abs(x-sideStream(z)) : -Infinity;
    return -Math.max(main,branch);
  };
  const channel=(x,z)=>Math.max(0,-bankGap(x,z));
  const waterHeight=z=>{
    if (!joined) return .75-(z-source)*.008;
    if (z<0) return .012-z*.012;
    return .012-Math.max(0,z-TOWN_SIZE.depth)*.012;
  };
  const isBridge=(x,z,crossing=24)=> (!joined || inCamp(x,z)) && Math.abs(z-crossing)<1.12 &&
    Math.abs(x-river(crossing))<3.65;
  function rawHeight(x,z) {
    let clearance=Infinity;
    for (const lot of flats) {
      if (x<lot.x-12 || z<lot.z-12 || x>lot.x+lot.w+12 || z>lot.z+lot.d+12) continue;
      clearance=Math.min(clearance,Math.hypot(Math.max(0,lot.x-x,x-lot.x-lot.w),
        Math.max(0,lot.z-z,z-lot.z-lot.d)));
      if (clearance===0) break;
    }
    const edge=land(x,z), ridge=rim(x,z);
    const broad=noise(seed+101,x,z,56), folds=noise(seed+102,x,z,21);
    const hill=(broad-.38)*8+(folds-.5)*2.5+(noise(seed+103,x,z,8)-.5)*.65;
    if (edge<0) return Math.max(WORLD_FLOOR,edge*5)+hill*.45;
    const mountain=1-smooth(-19,23,ridge);
    const ridgeHeight=15+folds*22;
    const channelGap=Math.min(Math.abs(x-river(z)),z>=source && z<=junction?Math.abs(x-sideStream(z)):Infinity);
    const valley=smooth(1.3,12,channelGap);
    const ground=waterHeight(z)+.65+(hill+mountain*ridgeHeight)*valley;
    const riverCut=(1-smooth(sourceWidth(z)-.35,sourceWidth(z)+1.55,Math.abs(x-river(z))))*smooth(source-2,source+2,z);
    const sideCut=(1-smooth(sideWidth(z)-.35,sideWidth(z)+1.55,Math.abs(x-sideStream(z))))*
      smooth(branchSource-2,branchSource+2,z)*(1-smooth(junction,junction+2,z));
    const height=mix(ground,waterHeight(z)-.35,Math.max(riverCut,sideCut));
    if (!joined) return height;
    const distance=Math.hypot((x-55)*.84,(z-38)*1.15);
    const relief=hills.reduce((value,hill)=>Math.max(value,reliefAt(hill,x,z)),0);
    const local=smooth(22,86,distance);
    const grade=(mix(.13+hill*.12,height,local)+relief*(1-local*.6))*smooth(0,9,clearance);
    return mix(grade,waterHeight(z)-.35,Math.max(riverCut,sideCut));

  }
  function height(x,z) {
    const ix=Math.floor(x), iz=Math.floor(z), u=x-ix, v=z-iz;
    const a=rawHeight(ix,iz), c=rawHeight(ix+1,iz+1);
    return u>=v?a+(rawHeight(ix+1,iz)-a)*(u-v)+(c-a)*v
      :a+(rawHeight(ix,iz+1)-a)*(v-u)+(c-a)*u;
  }
  function groundAllows(x,z,crossing) {
    if (x<west+2 || x>=east-2 || z<north+2 || z>=south-2 || land(x,z)<1.5 || rim(x,z)<1.8) return false;
    if (isBridge(x,z,crossing)) return true;
    return channel(x,z)<=0 &&
      Math.max(Math.abs(height(x+.42,z)-height(x-.42,z)),Math.abs(height(x,z+.42)-height(x,z-.42)))<.8;
  }
  function treeAt(x,z,crossing) {
    const r=hash2(x,z,seed+26);
    const density=forestDensity(seed,x,z);
    return (!joined || !inCamp(x,z)) && r<=density && Math.abs(z-crossing)>=2 && land(x,z)>=5 && groundAllows(x,z,crossing) ? r : null;
  }
  const treeScale=(x,z)=>.72+hash2(x,z,seed+66)*.53;
  function walkable(x,z,crossing=24) {
    if (!groundAllows(x,z,crossing)) return false;
    const tx=Math.round((x-1)/2)*2+1, tz=Math.round((z-1)/2)*2+1;
    return Math.hypot(x-tx,z-tz)>=.33+.22*treeScale(tx,tz) || treeAt(tx,tz,crossing)===null;
  }
  let fall=270;
  while (fall<324 && land(river(fall),fall+1)>0) fall++;
  return {seed,joined,roadDistance,river,width,sourceWidth,sideWidth,source,branchSource,junction,sideStream,southEdge,rim,land,channel,bankGap,waterHeight,
    isBridge,rawHeight,height,walkable,treeAt,treeScale,fall};
}

export function moveWildWalker(landscape,x,z,dx,dz,crossing) {
  const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.14));
  for(let i=0;i<steps;i++) {
    const px=x+dx/steps, pz=z+dz/steps;
    if (landscape.walkable(px,z,crossing)) x=px;
    if (landscape.walkable(x,pz,crossing)) z=pz;
  }
  return [x,z];
}

const WATER=[30/255,61/255,75/255], FALL=[69/255,137/255,150/255];
function surface(world,x,z,h,slope) {
  const edge=world.land(x,z), rim=world.rim(x,z);
  const variation=noise(world.seed+61,x,z,23);
  const row=edge<0 || h>6 && (rim<25 || slope>.47) ? 2 :
    world.bankGap(x,z)<.3 ? 1 : 0;
  const tint=(edge<0?mix(.95,.45,smooth(1,30,-h)):.94+variation*.12)*Math.max(.76,1-slope*.16);
  return {color:[tint,tint,tint],row};
}
const put=(out,p,color,water,row,variant,road,bank)=>out.push(...p,...color,variant,row,road,bank,water);
function face(out,a,b,c,d,color,water=0,row=-1,variant=0,roads=[0,0,0,0],banks=[3,3,3,3]) {
  const points=[a,b,c,d];
  for (const i of [0,1,2,0,2,3]) put(out,points[i],color,water,row,variant,roads[i],banks[i]);

}
function streamRibbon(out,world,x0,z0,length,center,width,end,start=world.source) {
  for(let z=z0;z<z0+length;z++) {
    if (z<start || z>=end) continue;
    const a=center(z), b=center(z+1);
    if (a<x0 || a>=x0+REGION_SIZE) continue;
    const wa=width(z), wb=width(z+1), y=world.waterHeight(z), ny=world.waterHeight(z+1);
    for (const [l,r] of [[-1,0],[0,1]]) {
      const depth=[1-Math.abs(l),1-Math.abs(r),1-Math.abs(r),1-Math.abs(l)];
      face(out,[a+wa*l,y,z],[a+wa*r,y,z],[b+wb*r,ny,z+1],[b+wb*l,ny,z+1],WATER,-1,-1,0,
        [0,0,0,0],depth);
    }
  }
}
export function worldOverview(world) {
  const out=[],step=5;
  for (let z=north;z<south;z+=step) for(let x=west;x<east;x+=step) {
    const ax=Math.min(x+step,east), az=Math.min(z+step,south);
    const a=world.rawHeight(x,z), b=world.rawHeight(ax,z), c=world.rawHeight(ax,az), d=world.rawHeight(x,az);
    const midX=(x+ax)/2, midZ=(z+az)/2;
    const {row,color}=surface(world,midX,midZ,(a+b+c+d)*.25,Math.max(Math.abs(a-b),Math.abs(a-d))/step);
    face(out,[x,a,z],[ax,b,z],[ax,c,az],[x,d,az],color,0,row,Math.floor(hash2(x,z,world.seed+19)*4));
  }
  for(let cx=Math.floor(west/REGION_SIZE);cx<=Math.floor(east/REGION_SIZE);cx++) {
    streamRibbon(out,world,cx*REGION_SIZE,north,south-north,world.river,world.sourceWidth,world.fall);
    streamRibbon(out,world,cx*REGION_SIZE,north,south-north,world.sideStream,world.sideWidth,world.junction,world.branchSource);
  }
  return new Float32Array(out);
}

export function wildRegion(world,cx,cz) {
  const x0=cx*REGION_SIZE,z0=cz*REGION_SIZE,out=[];
  const pitch=REGION_SIZE+1, heights=new Float32Array(pitch*pitch), roads=new Float32Array(pitch*pitch);
  for (let z=0;z<pitch;z++) for (let x=0;x<pitch;x++) {
    const i=z*pitch+x;
    heights[i]=world.rawHeight(x0+x,z0+z);
    roads[i]=Math.max(0,2.4-(world.roadDistance?.(x0+x,z0+z)??3));
  }
  for (let z=z0;z<z0+REGION_SIZE;z++) for (let x=x0;x<x0+REGION_SIZE;x++) {
    const i=(z-z0)*pitch+x-x0, [a,b,c,d]=[heights[i],heights[i+1],heights[i+pitch+1],heights[i+pitch]];
    const {color,row}=surface(world,x+.5,z+.5,(a+b+c+d)*.25,Math.max(Math.abs(a-b),Math.abs(a-d)));
    const variant=Math.floor(hash2(x,z,world.seed+19)*4);
    const road=[roads[i],roads[i+1],roads[i+pitch+1],roads[i+pitch]];
    const bank=[[x,z],[x+1,z],[x+1,z+1],[x,z+1]].map(([px,pz])=>Math.min(3,world.bankGap(px,pz)));
    if (Math.min(...bank)>.8 || Math.max(...bank)<-.8) {
      face(out,[x,a,z],[x+1,b,z],[x+1,c,z+1],[x,d,z+1],color,0,row,variant,road,bank);
      continue;
    }
    const interpolate=([p,q,r,s],u,v)=>u>=v ? p+(q-p)*(u-v)+(r-p)*v : p+(s-p)*(v-u)+(r-p)*u;
    for (let v=0;v<1;v+=.25) for(let u=0;u<1;u+=.25) {
      const offsets=[[u,v],[u+.25,v],[u+.25,v+.25],[u,v+.25]];
      const corners=offsets.map(([dx,dz])=>[x+dx,interpolate([a,b,c,d],dx,dz),z+dz]);
      face(out,...corners,color,0,row,variant,offsets.map(([dx,dz])=>interpolate(road,dx,dz)),
        corners.map(([px,,pz])=>Math.min(3,world.bankGap(px,pz))));
    }
  }
  const lip=world.fall;
  streamRibbon(out,world,x0,z0,REGION_SIZE,world.river,world.sourceWidth,lip);
  if (z0+REGION_SIZE>world.branchSource)
    streamRibbon(out,world,x0,z0,REGION_SIZE,world.sideStream,world.sideWidth,world.junction,world.branchSource);
  const x=world.river(lip);
  if (Math.floor(x/REGION_SIZE)===cx && Math.floor(lip/REGION_SIZE)===cz) {
    const y=world.waterHeight(lip), w=world.width(lip);
    const bottom=-21, drop=5.8;
    for (let i=0;i<8;i++) {
      const t=i/8, next=(i+1)/8;
      const point=(f,side)=>[x+side*w*(1-.24*f),mix(y,bottom,f),lip+drop*f];
      face(out,point(t,-1),point(t,1),point(next,1),point(next,-1),FALL,-2);
    }
    face(out,[x-w*2,-20.98,lip+4.6],[x+w*2,-20.98,lip+4.6],
      [x+w*2.6,-20.98,lip+8],[x-w*2.6,-20.98,lip+8],[.45,.58,.59],-1);
  }
  if (z0+REGION_SIZE>=272 && z0<325) {
    for (let ix=x0;ix<x0+REGION_SIZE;ix+=2) {
      const z=world.southEdge(ix)+6;
      if (z<z0 || z>=z0+REGION_SIZE) continue;
      const h=-13+3*Math.sin(ix*.19);
      face(out,[ix,h,z],[ix+2,h,z],[ix+2,h,z+8],[ix,h,z+8],[.28,.38,.42]);
    }
  }
  return new Float32Array(out);
}

export function wildDetails(world,cx,cz,crossing) {
  const trees=[], plants=[], x0=cx*REGION_SIZE, z0=cz*REGION_SIZE;
  for(let z=z0+1;z<z0+REGION_SIZE;z+=2) for(let x=x0+1;x<x0+REGION_SIZE;x+=2) {
    const r=world.treeAt(x,z,crossing), variant=Math.floor(hash2(x,z,world.seed+92)*4);
    if (r!==null) trees.push({x,z,y:world.height(x,z),variant,scale:world.treeScale(x,z)});

  }
  for (let tz=z0;tz<z0+REGION_SIZE;tz++) for (let tx=x0;tx<x0+REGION_SIZE;tx++) {
    if (world.joined && inCamp(tx,tz)) continue;
    const x=tx+.23+hash2(tx,tz,world.seed+94)*.54;
    const z=tz+.23+hash2(tx,tz,world.seed+95)*.54;
    const scatter=hash2(tx,tz,world.seed+91);
    const patch=noise(world.seed+96,x,z,10);
    const bank=world.bankGap(x,z), riverside=bank>.4 && bank<3;
    const density=.095+patch*.14+(riverside?.08:0);
    if (scatter>=density || bank<.34 || !world.walkable(x,z,crossing)) continue;
    const species=hash2(tx,tz,world.seed+93), variant=Math.floor(hash2(tx,tz,world.seed+92)*4);
    const kind=species<.19?'flower':species>.86?'shrub':'grass';
    plants.push({x,z,y:world.height(x,z),variant,kind});
  }
  const detail=wildVegetation(trees,plants);
  const x=world.river(crossing);
  if (!world.joined && Math.floor(x/REGION_SIZE)===cx && Math.floor(crossing/REGION_SIZE)===cz) {
    for(let i=0;i<19;i++) detail.box(x-3.65+i*.39,world.waterHeight(crossing)+.46,crossing-1.12,.385,.12,2.24,
      i%2?'#A9865F':'#8E6849');
  }
  return detail;
}

export function regionWindow(x,z) {
  const cx=Math.floor(x/REGION_SIZE), cz=Math.floor(z/REGION_SIZE);
  const entries=[];
  for(let dz=-2;dz<=2;dz++) for(let dx=-2;dx<=2;dx++) {
    const a=cx+dx,b=cz+dz;
    if ((a+1)*REGION_SIZE<=west || a*REGION_SIZE>=east || (b+1)*REGION_SIZE<=north || b*REGION_SIZE>=south) continue;
    entries.push({key:a+':'+b,x:a,z:b,near:Math.max(Math.abs(dx),Math.abs(dz))<=1});
  }
  return entries;
}

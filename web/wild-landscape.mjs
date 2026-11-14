import { campHash, campTerrain, hash2 } from './camp-terrain.mjs';
import { TOWN_SIZE } from './camp-layout.mjs';
import { wildVegetation } from './camp-3d-scene.mjs';

export const REGION_SIZE=24;
export const WILDS=Object.freeze({west:-240,east:TOWN_SIZE.width+240,north:-220,south:TOWN_SIZE.depth+270});
const {west,east,north,south}=WILDS;
const WORLD_FLOOR=-29;
export const inCamp=(x,z)=>x>=0 && x<TOWN_SIZE.width && z>=0 && z<TOWN_SIZE.depth;
const seamDistance=(x,z)=>Math.hypot(Math.max(0,-x,x-TOWN_SIZE.width),Math.max(0,-z,z-TOWN_SIZE.depth));

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

export function wildLandscape(seed,version,{joined=false}={}) {
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
  const channel=(x,z)=> {
    if (z<source || land(x,z)<0) return 0;
    const main=sourceWidth(z)-Math.abs(x-river(z));
    const branch=z>=branchSource && z<=junction ? sideWidth(z)-Math.abs(x-sideStream(z)) : -Infinity;
    return Math.max(0,main,branch);
  };
  const waterHeight=z=>{
    if (!joined) return .75-(z-source)*.008;
    if (z<0) return .012-z*.012;
    return .012-Math.max(0,z-TOWN_SIZE.depth)*.012;
  };
  const isBridge=(x,z,crossing=24)=> Math.abs(z-crossing)<1.12 &&
    Math.abs(x-river(crossing))<3.65;
  function rawHeight(x,z) {
    const edge=land(x,z), ridge=rim(x,z);
    const hills=noise(seed+101,x,z,56), folds=noise(seed+102,x,z,21);
    const hill=(hills-.38)*8+(folds-.5)*2.5+(noise(seed+103,x,z,8)-.5)*.65;
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
    return joined ? height*smooth(0,12,seamDistance(x,z)) : height;
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
    const forest=noise(seed+27,x,z,40)*.73+noise(seed+28,x,z,13)*.27;
    const density=mix(.026,.41,smooth(.31,.76,forest));
    return (!joined || seamDistance(x,z)>=2) && r<=density && Math.abs(z-crossing)>=2 && land(x,z)>=5 && groundAllows(x,z,crossing) ? r : null;
  }
  const treeScale=(x,z)=>.72+hash2(x,z,seed+66)*.53;
  function walkable(x,z,crossing=24) {
    if (!groundAllows(x,z,crossing)) return false;
    const tx=Math.round((x-1)/2)*2+1, tz=Math.round((z-1)/2)*2+1;
    return Math.hypot(x-tx,z-tz)>=.33+.22*treeScale(tx,tz) || treeAt(tx,tz,crossing)===null;
  }
  let fall=270;
  while (fall<324 && land(river(fall),fall+1)>0) fall++;
  return {seed,joined,river,width,sourceWidth,sideWidth,source,branchSource,junction,sideStream,southEdge,rim,land,channel,waterHeight,
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
  const waterGap=Math.min(Math.abs(x-world.river(z))-world.sourceWidth(z),
    z>=world.branchSource&&z<=world.junction?Math.abs(x-world.sideStream(z))-world.sideWidth(z):Infinity);
  const variation=noise(world.seed+61,x,z,23), rough=hash2(x,z,world.seed+62);
  const row=edge<0 || h>6 && (rim<25 || slope>.47) ? 2 :
    z>=world.source && waterGap<.8+rough*.3 ? 1 : 0;
  const tint=(edge<0?mix(.95,.45,smooth(1,30,-h)):.94+variation*.12)*Math.max(.76,1-slope*.16);
  return {color:[tint,tint,tint],row};
}
const put=(out,p,color,water,row,variant)=>out.push(...p,...color,variant,row,0,0,water);
function face(out,a,b,c,d,color,water=0,row=-1,variant=0) {
  for (const p of [a,b,c,a,c,d]) put(out,p,color,water,row,variant);
}
function streamRibbon(out,world,x0,z0,length,center,width,end,start=world.source) {
  for(let z=z0;z<z0+length;z++) {
    if (z<start || z>=end || world.joined && inCamp(center(z),z)) continue;
    const a=center(z), b=center(z+1);
    if (a<x0 || a>=x0+REGION_SIZE) continue;
    const wa=width(z), wb=width(z+1), y=world.waterHeight(z), ny=world.waterHeight(z+1);
    face(out,[a-wa,y,z],[a+wa,y,z],[b+wb,ny,z+1],[b-wb,ny,z+1],WATER,-1);
  }
}
export function wildRegion(world,cx,cz) {
  const x0=cx*REGION_SIZE,z0=cz*REGION_SIZE,out=[];
  const pitch=REGION_SIZE+1, heights=new Float32Array(pitch*pitch);
  for (let z=0;z<pitch;z++) for (let x=0;x<pitch;x++) heights[z*pitch+x]=world.rawHeight(x0+x,z0+z);
  for (let z=z0;z<z0+REGION_SIZE;z++) for (let x=x0;x<x0+REGION_SIZE;x++) {
    if (world.joined && inCamp(x,z)) continue;
    const i=(z-z0)*pitch+x-x0, [a,b,c,d]=[heights[i],heights[i+1],heights[i+pitch+1],heights[i+pitch]];
    const {color,row}=surface(world,x,z,(a+b+c+d)*.25,Math.max(Math.abs(a-b),Math.abs(a-d)));
    face(out,[x,a,z],[x+1,b,z],[x+1,c,z+1],[x,d,z+1],color,0,row,Math.floor(hash2(x,z,world.seed+19)*4));
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
    else if ((!world.joined || !inCamp(x,z)) && hash2(x,z,world.seed+91)<.26 && world.walkable(x,z,crossing)) {
      plants.push({x,z,y:world.height(x,z),variant,shrub:hash2(x,z,world.seed+93)<.21});
    }
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

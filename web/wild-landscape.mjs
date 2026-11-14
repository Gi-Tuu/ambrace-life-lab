import { campHash, campTerrain, hash2 } from './camp-terrain.mjs';
import { TOWN_SIZE } from './camp-layout.mjs';

export const REGION_SIZE=24;
export const WILDS=Object.freeze({west:-240,east:TOWN_SIZE.width+240,north:-220,south:TOWN_SIZE.depth+270});
const {west,east,north,south}=WILDS;
const WORLD_FLOOR=-29;
const smooth=(a,b,v)=>{
  const t=Math.max(0,Math.min(1,(v-a)/(b-a)));
  return t*t*(3-2*t);
};
const mix=(a,b,t)=>a+(b-a)*t;

export function wildLandscape(seed,version) {
  const {riverCenter,riverHalfWidth}=campTerrain(seed,false,version);
  const phase=campHash(seed,'wilds')*Math.PI*2;
  const width=z=>riverHalfWidth(z*16)/16;
  const river=z=>riverCenter(z*16)/16;
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
  const waterHeight=z=>.75-(z-source)*.008;
  const isBridge=(x,z,crossing=24)=> Math.abs(z-crossing)<1.12 &&
    Math.abs(x-river(crossing))<3.65;
  function rawHeight(x,z) {
    const edge=land(x,z), ridge=rim(x,z);
    const hill=(Math.sin(x*.086+z*.039+phase)*Math.cos(z*.12-x*.029)*1.2+
      Math.sin(x*.21-z*.12)*.36);
    if (edge<0) return Math.max(WORLD_FLOOR,edge*5)+hill*.45;
    const mountain=1-smooth(-19,23,ridge);
    const folds=(.63+.21*Math.sin(x*.135+z*.092+phase)+.13*Math.cos(z*.29-x*.08));
    const channelGap=Math.min(Math.abs(x-river(z)),z>=source && z<=junction?Math.abs(x-sideStream(z)):Infinity);
    const valley=smooth(1.3,12,channelGap);
    const ground=waterHeight(z)+.65+hill*valley+mountain*folds*33*valley;
    const riverCut=(1-smooth(sourceWidth(z)-.35,sourceWidth(z)+1.55,Math.abs(x-river(z))))*smooth(source-2,source+2,z);
    const sideCut=(1-smooth(sideWidth(z)-.35,sideWidth(z)+1.55,Math.abs(x-sideStream(z))))*
      smooth(branchSource-2,branchSource+2,z)*(1-smooth(junction,junction+2,z));
    return mix(ground,waterHeight(z)-.35,Math.max(riverCut,sideCut));
  }
  function height(x,z) {
    const ix=Math.floor(x), iz=Math.floor(z), u=x-ix, v=z-iz;
    const a=rawHeight(ix,iz), c=rawHeight(ix+1,iz+1);
    return u>=v?a+(rawHeight(ix+1,iz)-a)*(u-v)+(c-a)*v
      :a+(rawHeight(ix,iz+1)-a)*(v-u)+(c-a)*u;
  }
  function groundAllows(x,z,crossing) {
    if (x<west+2 || x>=east-2 || z<north+2 || z>=south-2 || land(x,z)<1.5 || rim(x,z)<1.8) return false;
    const h=height(x,z);
    if (isBridge(x,z,crossing)) return true;
    return channel(x,z)<=0 && (z<source || h>=waterHeight(z)-.02) &&
      Math.max(Math.abs(height(x+.42,z)-height(x-.42,z)),Math.abs(height(x,z+.42)-height(x,z-.42)))<.8;
  }
  function treeAt(x,z,crossing) {
    const r=hash2(x,z,seed+26), density=.5+.5*Math.sin(x*.09+z*.12);
    return r<=.065+density*.09 && Math.abs(z-crossing)>=2 && land(x,z)>=5 && groundAllows(x,z,crossing) ? r : null;
  }
  function walkable(x,z,crossing=24) {
    if (!groundAllows(x,z,crossing)) return false;
    const tx=Math.round((x-1)/2)*2+1, tz=Math.round((z-1)/2)*2+1;
    return Math.hypot(x-tx,z-tz)>=.37 || treeAt(tx,tz,crossing)===null;
  }
  let fall=270;
  while (fall<324 && land(river(fall),fall+1)>0) fall++;
  return {seed,river,width,sourceWidth,sideWidth,source,branchSource,junction,sideStream,southEdge,rim,land,channel,waterHeight,
    isBridge,rawHeight,height,walkable,treeAt,fall};
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

const GRASS=[.28,.42,.24], MEADOW=[.39,.49,.27], ROCK=[.41,.40,.35], DEEP=[.11,.17,.20];
const STONE=[.38,.37,.34], SHORE=[.45,.38,.25], WATER=[.22,.44,.49], FALL=[.52,.69,.71];
const FOREST=['#294633','#34583B','#40613B','#516F43'];
function terrainColor(world,x,z,h) {
  const rand=hash2(x,z,world.seed), edge=world.land(x,z), rim=world.rim(x,z);
  const waterGap=Math.min(Math.abs(x-world.river(z)),z>=world.source&&z<=world.junction?Math.abs(x-world.sideStream(z)):Infinity);
  const tint=edge<0 ? mix(1,.2,smooth(1,30,-h)) : .91+rand*.17;
  let color=edge<0 ? STONE : rim<17 && h>3 ? ROCK : waterGap<2.4 && z>=world.source ? SHORE :
    (Math.sin(x*.17+z*.2)+rand>.85?MEADOW:GRASS);
  if (edge<0) color=color.map((v,i)=>mix(DEEP[i],v,tint));
  return edge<0 ? color : color.map(v=>v*tint);
}
const put=(out,p,color,water)=>out.push(...p,...color,0,0,0,0,water);
function face(out,a,b,c,d,color,water=0) {
  for (const p of [a,b,c,a,c,d]) put(out,p,color,water);
}
function streamRibbon(out,world,x0,z0,length,center,width,end,start=world.source) {
  for(let z=z0;z<z0+length;z++) {
    if (z<start || z>=end) continue;
    const a=center(z), b=center(z+1);
    if (a<x0 || a>=x0+REGION_SIZE) continue;
    const wa=width(z), wb=width(z+1), y=world.waterHeight(z), ny=world.waterHeight(z+1);
    face(out,[a-wa,y,z],[a+wa,y,z],[b+wb,ny,z+1],[b-wb,ny,z+1],WATER,-1);
  }
}
export function wildRegion(world,cx,cz) {
  const x0=cx*REGION_SIZE,z0=cz*REGION_SIZE,out=[];
  for (let z=z0;z<z0+REGION_SIZE;z++) for (let x=x0;x<x0+REGION_SIZE;x++) {
    const a=world.rawHeight(x,z), b=world.rawHeight(x+1,z), c=world.rawHeight(x+1,z+1), d=world.rawHeight(x,z+1);
    const color=terrainColor(world,x,z,a).map(v=>v*Math.min(1.13,Math.max(.69,1+(a-b)*.08+(d-a)*.05)));
    face(out,[x,a,z],[x+1,b,z],[x+1,c,z+1],[x,d,z+1],color);
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
  const boxes=[], x0=cx*REGION_SIZE, z0=cz*REGION_SIZE;
  const box=(x,y,z,w,h,d,color)=>boxes.push({x,y,z,w,h,d,color});
  for(let z=z0+1;z<z0+REGION_SIZE;z+=2) for(let x=x0+1;x<x0+REGION_SIZE;x+=2) {
    const r=world.treeAt(x,z,crossing);
    if (r===null) continue;
    const y=world.height(x,z), h=1.4+r*5, c=FOREST[Math.floor(hash2(z,x,91)*FOREST.length)];
    box(x-.08,y,z-.08,.16,h*.78,.16,'#584635');
    for(let tier=0;tier<3;tier++) {
      const w=(1.24-tier*.28)*h*.6;
      box(x-w/2,y+h*(.44+tier*.24),z-w/2,w,h*.25,w,c);
    }
  }
  const x=world.river(crossing);
  if (Math.floor(x/REGION_SIZE)===cx && Math.floor(crossing/REGION_SIZE)===cz) {
    for(let i=0;i<19;i++) box(x-3.65+i*.39,world.waterHeight(crossing)+.46,crossing-1.12,.385,.12,2.24,
      i%2?'#A9865F':'#8E6849');
  }
  return {boxes,floors:[]};
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

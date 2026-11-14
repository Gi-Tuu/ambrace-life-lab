import { campCamera, createCampRenderer } from './camp-3d-render.mjs';
import { moveWildWalker, regionWindow, wildLandscape, wildRegion, wildDetails, WILDS, REGION_SIZE } from './wild-landscape.mjs';
import { walkDirection } from './walk.mjs';

const canvas=document.querySelector('#wilds'), status=document.querySelector('#location');
const returnButton=document.querySelector('#return'), keys=new Set();
const aliases={arrowup:'w',arrowleft:'a',arrowdown:'s',arrowright:'d',w:'w',a:'a',s:'s',d:'d',shift:'shift'};
const cache=new Map(), stats={generated:0,chunkMs:[],renderMs:[],frames:0,crossings:0};
const stage={width:WILDS.east-WILDS.west,depth:WILDS.south-WILDS.north};
const limit=42;
let renderer, landscape, crossing, player, home, last, activeKey, regions, previousCell, pendingResize=true;
const canvasSize=new ResizeObserver(()=>{pendingResize=true;});
canvasSize.observe(canvas);
function boundedSample(samples,n) {
  if (samples.length===160) samples.shift();
  samples.push(n);
}
function visible() {
  const window=regionWindow(player.x,player.z), key=window.map(b=>b.key+(b.near?'*':'')).join(',');
  if (key===activeKey) return regions;
  activeKey=key;
  const buffers=[];
  for (const b of window) {
    let chunk=cache.get(b.key);
    cache.delete(b.key);
    if (!chunk) {
      const start=performance.now();
      const mesh=wildRegion(landscape,b.x,b.z);
      chunk={ground:{mesh,wild:true}};
      stats.generated++;
      boundedSample(stats.chunkMs,performance.now()-start);
    }
    cache.set(b.key,chunk);
    buffers.push(chunk.ground);
    if (b.near) {
      chunk.details??={...wildDetails(landscape,b.x,b.z,crossing),wild:true};
      buffers.push(chunk.details);
    }
  }
  while (cache.size>limit) cache.delete(cache.keys().next().value);
  return regions=buffers;
}
function frame(now) {
  if (pendingResize) {
    const rect=canvas.getBoundingClientRect(), scale=Math.min(1.5,devicePixelRatio);
    canvas.width=Math.max(1,Math.min(1280,Math.round(rect.width*scale)));
    canvas.height=Math.max(1,Math.round(canvas.width*rect.height/rect.width));
    pendingResize=false;
  }
  const dt=last===undefined?0:Math.min(.05,(now-last)/1000);
  last=now;
  const dx=Number(keys.has('d'))-Number(keys.has('a')), dz=Number(keys.has('s'))-Number(keys.has('w'));
  const length=Math.hypot(dx,dz);
  if (length) {
    const speed=(keys.has('shift')?9:5)*dt/length;
    const [x,z]=moveWildWalker(landscape,player.x,player.z,dx*speed,dz*speed,crossing);
    player.direction=walkDirection(x-player.x,z-player.z,player.direction);
    player.moving=x!==player.x || z!==player.z;
    player.x=x; player.z=z;
  } else player.moving=false;
  player.y=landscape.isBridge(player.x,player.z,crossing)?landscape.waterHeight(crossing)+.58:landscape.height(player.x,player.z);
  const cell=Math.floor(player.x/REGION_SIZE)+':'+Math.floor(player.z/REGION_SIZE);
  if (cell!==previousCell) { if (previousCell!==undefined) stats.crossings++; previousCell=cell; }
  const camera=campCamera({x:player.x,z:player.z,width:canvas.width,height:canvas.height,
    span:canvas.width<600?34:46,yaw:.32,pitch:.69,targetY:player.y+.7});
  const start=performance.now();
  const ok=renderer.render({target:canvas,stage,regions:visible(),camera,people:[player],
    frame:Math.floor(now/115)%4,light:[1,.98,.91],weather:[now/1000,0,0,0]});
  if (!ok) { status.textContent='3D 绘制已停止，请重新载入页面。'; return; }
  boundedSample(stats.renderMs,performance.now()-start);
  if (stats.frames++%10===0) {
    const where=landscape.land(player.x,player.z)<9?'南缘悬崖':
      landscape.rim(player.x,player.z)<15?'山脊山麓':player.z<-35?'北侧山谷':Math.abs(player.z-crossing)<4?'营地路口':'荒野河谷';
    status.textContent=where+' · '+Math.floor(player.x)+'，'+Math.floor(player.z)+' · 地图种子 '+landscape.seed;
  }
  requestAnimationFrame(frame);
}
for (const [event,pressed] of [['keydown',true],['keyup',false]]) addEventListener(event,e=>{
  const key=aliases[e.key.toLowerCase()];
  if (!key || e.altKey || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (pressed) keys.add(key); else keys.delete(key);
});
addEventListener('blur',()=>{keys.clear();last=undefined;});
document.addEventListener('visibilitychange',()=>{keys.clear();last=undefined;});
for (const button of document.querySelectorAll('[data-dir]')) {
  button.addEventListener('pointerdown',e=>{button.setPointerCapture(e.pointerId);keys.add(button.dataset.dir);});
  for (const event of ['pointerup','pointercancel','lostpointercapture'])
    button.addEventListener(event,()=>keys.delete(button.dataset.dir));
}
returnButton.onclick=()=>{Object.assign(player,home);canvas.focus();};
async function start() {
  renderer=createCampRenderer();
  if (!renderer) { status.textContent='浏览器未启用 WebGL，无法试走 3D 荒野。';return; }
  const params=new URLSearchParams(location.search);
  let w;
  try {
    const res=await fetch('/world?mode=menu');
    if (res.ok) w=(await res.json()).survival;
  } catch { /* 独立地图可以用默认种子运行。 */ }
  const candidate=Number(params.get('seed'));
  const hasSeed=params.has('seed') && Number.isSafeInteger(candidate);
  const seed=hasSeed?candidate:w?.mapSeed??0;
  const version=hasSeed?1:w?.layoutVersion??0;
  crossing=(hasSeed?null:w?.layout?.crossZ)??24;
  landscape=wildLandscape(seed,version);
  const bridgeX=landscape.river(crossing);
  const spawn=Array.from({length:14},(_,i)=>bridgeX-6-i*.5).find(x=>landscape.walkable(x,crossing,crossing));
  home={x:spawn??bridgeX-3,z:crossing,direction:'down'};
  player={...home,who:'p1',color:'#AB5236'};
  returnButton.disabled=false;
  window.__wildsDebug={
    stats:()=>({...stats,visible:regions?.length??0,cached:cache.size,cpuMeshBytes:[...cache.values()].reduce((sum,b)=>sum+b.ground.mesh.byteLength,0),
      gpu:renderer.regionStats(),player:{...player},crossing,seed,version}),
    moveTo:(x,z)=>{if(!landscape.walkable(x,z,crossing))return false;Object.assign(player,{x,z});return true;},
    landscape,
  };
  requestAnimationFrame(frame);
}
start().catch(()=>{status.textContent='荒野地图加载失败，请重新载入页面。';});

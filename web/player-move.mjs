// 玩家与角色的行走几何：碰撞栅格、外部可走性、绕人重算、路线拼接。
// 从 web/app.js 抽出（2026-11-15，阶段 3）。抽出的都是纯函数：给定 world/walker 就出结果，
// 不读 DOM、不读模块级状态、不消费随机——所以可以直接单测（见 life/player-move.test.mjs）。
import { CAMP_BODY_RADIUS, bodyGrid } from '../shared/camp-physics.mjs';
import { inCamp } from '../shared/wild-landscape.mjs';
import { joinedRoute } from '../shared/camp-outskirts.mjs';
import { mapAllows, pathFromWalker } from './collision.mjs';
import { fillCollisionRect, pixelPath } from '../shared/asset-collision.mjs';

export const TILE = 16; // 寻路与布局单位；美术原生 32px，通过独立密度映射，避免改动世界坐标。

export function rectGap(x,z,left,top,w,d) {
  return Math.hypot(Math.max(left-x,x-left-w,0),Math.max(top-z,z-top-d,0));
}

export function campBodyWorld(world,openEdge=false) {
  // P2：bodyGrid 仍是体半径膨胀的实现，但碰撞判定由 world.space 统一回答（mapAllows/moveMapFeet）。
  return { ...world, collisionGrid:bodyGrid(world.collisionGrid,TILE,openEdge), space:world.space ?? null };
}

// 契约收紧：缺 world.landscape 时以前返回 undefined，现在一律返回真正的布尔。
// 所有调用点都在布尔上下文里（条件 / 逻辑与），判定结果逐位不变，但可单测。
export function exteriorAllows(world,x,z) {
  return Boolean(world.landscape?.walkable(x,z)) &&
    !(world.outsideSolids??[]).some(b=>rectGap(x,z,b.x,b.z,b.w,b.d)<CAMP_BODY_RADIUS);
}

export function detourAroundBodies(world,walker,neighbours) {
  const nearby=neighbours.filter(o=>Math.hypot(o.x-walker.x-.5,o.z-walker.y-.5)<2.5);
  if (!nearby.length) return null;
  const grid=world.collisionGrid, walk=grid.walk.slice();
  for (const o of nearby) {
    const r=o.r+CAMP_BODY_RADIUS+.08;
    const x=Math.floor((o.x-r)*TILE), z=Math.floor((o.z-r)*TILE);
    fillCollisionRect(walk,grid.tw,grid.th,x,z,Math.ceil((o.x+r)*TILE)-x,Math.ceil((o.z+r)*TILE)-z,0);
  }
  const pixel=coordinate=>Math.floor((coordinate+.5)*TILE);
  const [goalX,goalZ]=walker.path.at(-1);
  const path=pixelPath({...grid,walk},[pixel(walker.x),pixel(walker.y)],[pixel(goalX),pixel(goalZ)]);
  return path?.length ? path.map(cell=>cell.map(v=>(v+.5)/TILE-.5)) : null;
}

export function routeForWalker(world, walker, goal, bodies=[]) {
  const from=[walker.x+.5,walker.y+.5], to=goal.map(v=>v+.5);
  if (world.landscape && (!inCamp(...from) || !inCamp(...to))) {
    const map=campBodyWorld(world,true);
    const allows=(x,z)=>(inCamp(x,z)?mapAllows(map,x-.5,z-.5):exteriorAllows(world,x,z)) &&
      bodies.every(b=>Math.hypot(x-b.x,z-b.z)>=b.r+CAMP_BODY_RADIUS+.05);
    return joinedRoute(from,to,allows)
      ?.map(p=>p.map(v=>v-.5))??null;
  }
  const path = pathFromWalker(world, walker, goal);
  if (!world.scene3d) return path;
  world=campBodyWorld(world);
  if (!mapAllows(world,...goal)) return null;
  // 快速路线在穿过窄栏杆时可能遗漏细格，逐段复核后再采用。
  if (path) {
    let x=walker.x, z=walker.y;
    const complete=[...path,goal], smooth=[];
    const clear=([nx,nz])=>{
      const dx=nx-x, dz=nz-z, steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)*TILE*2));
      for (let i=1;i<=steps;i++) {
        const px=x+dx*i/steps, pz=z+dz*i/steps;
        if (!mapAllows(world,px,pz) || !mapAllows(world,px,pz-dz/steps)) return false;
      }
      return true;
    };
    for (let i=0;i<complete.length;) {
      let next=Math.min(i+2,complete.length-1);
      while (next>i && !clear(complete[next])) next-=1;
      if (!clear(complete[next])) break;
      [x,z]=complete[next];
      smooth.push(complete[next]);
      i=next+1;
      if (i===complete.length) return smooth;
    }
  }
  const pixel = v=>Math.floor((v+.5)*TILE);
  const start = [pixel(walker.x),pixel(walker.y)];
  const exact = pixelPath(world.collisionGrid,start,goal.map(pixel));
  if (!exact?.length) return exact;
  return [start,...exact].map(cell=>cell.map(v=>(v+.5)/TILE-.5));
}

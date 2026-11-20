import { astar, isWalkable } from './walk.mjs';
import { pixelPath } from '../shared/asset-collision.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { ROOM_GRID } from '../shared/room-layout.mjs';

export const COLLISION_CELL = 1;
export { ROOM_GRID };

export function collisionIndex(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
  return Math.floor(y / grid.cell) * (grid.width / grid.cell) + Math.floor(x / grid.cell);
}

// 行走器仍使用 16px 地图坐标。寻路索引把同一脚点换算到逐像素网格。
const mapCell = (point, scale) => Math.floor((point + 0.5) * scale);
const mapCenter = (index, scale) => (index + 0.5) / scale - 0.5;

// P4：可走性只有一个答案 —— world.space（地形链 + collidersNear + 体半径）。
// 像素栅格降级为寻路索引（world.pathGrid），不再参与“能不能站”的裁决，也没有第二套回退。
export function mapAllows(world, x, y) {
  const space = world?.space;
  if (!space) return false; // 正式世界必有 space；缺失是构造错误，宁可站住也不回退另一套几何
  return space.walkable(x + 0.5, y + 0.5, CAMP_BODY_RADIUS);
}

export function moveMapFeet(world, x, y, dx, dy, fits) {
  const index = world.pathGrid ?? world;
  const scale = index.tw / world.tw;
  const startX = mapCell(x, scale), startY = mapCell(y, scale);
  const clear = (px, py) => {
    const tx = mapCell(px, scale), ty = mapCell(py, scale);
    const escape = tx === startX && ty === startY && tx >= 0 && ty >= 0 && tx < index.tw && ty < index.th;
    // 逐轴分步保留（防穿角）；可走性由 space 统一回答（含体半径），起始格豁免保留编辑期逃生。
    const walkable = Boolean(world.space) && world.space.walkable(px + 0.5, py + 0.5, CAMP_BODY_RADIUS);
    return (!fits || fits(x, y, px, py)) && (walkable || escape);
  };
  const steps = scale > 2 ? Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * scale)) : 1;
  for (let i = 0; i < steps; i += 1) {
    if (clear(x + dx / steps, y)) x += dx / steps;
    if (clear(x, y + dy / steps)) y += dy / steps;
  }
  return [x, y];
}

export function pathFromWalker(world, walker, goal) {
  const grid = world.pathGrid ?? world;
  const scale = grid.tw / world.tw;
  // 细网格（像素级）下逐像素 A* 太慢且易失败 ⇒ 采样回 tile 级走格寻路（点击移动/引擎挪人共用）
  if (scale > 2) {
    const tile = tileWalkOf(world, grid, scale);
    const start = [Math.round(walker.x), Math.round(walker.y)];
    const target = [Math.round(goal[0]), Math.round(goal[1])];
    return astar(tile, start, target);
  }
  const start = [mapCell(walker.x, scale), mapCell(walker.y, scale)];
  const find = scale > 2 ? pixelPath : astar;
  const path = find(grid, start, goal.map(point => mapCell(point, scale)));
  if (!path) return null;
  const [x, y] = start.map(index => mapCenter(index, scale));
  if (walker.x !== x || walker.y !== y) path.unshift(start);
  return path.map(cell => cell.map(index => mapCenter(index, scale)));
}

const tileWalkCache = new WeakMap();
function tileWalkOf(world, grid, scale) {
  let cached = tileWalkCache.get(grid);
  if (!cached || cached.rev !== world.collisionRevision) {
    const walk = new Uint8Array(world.tw * world.th);
    for (let ty = 0; ty < world.th; ty += 1) for (let tx = 0; tx < world.tw; tx += 1) {
      walk[ty * world.tw + tx] = isWalkable(grid, Math.floor((tx + 0.5) * scale), Math.floor((ty + 0.5) * scale)) ? 1 : 0;
    }
    cached = { rev: world.collisionRevision, tw: world.tw, th: world.th, walk };
    tileWalkCache.set(grid, cached);
  }
  return cached;
}

export function overrideWalk(base, cells, assetPixels) {
  if (!cells.size) return base;
  const walk = base.slice();
  for (const [index, value] of cells) {
    if (value === 0 || assetPixels?.[index] !== 0) walk[index] = value;
  }
  return walk;
}

export function writeCollisionData(scenes, grids) {
  const entries = [];
  for (const [name, cells] of scenes) {
    if (!cells.size) continue;
    const runs = [];
    for (const [index, state] of [...cells].sort(([a], [b]) => a - b)) {
      const run = runs.at(-1);
      if (run && run[0] + run[1] === index && run[2] === state) run[1] += 1;
      else runs.push([index, 1, state]);
    }
    entries.push([name, runs]);
  }
  const map=grids?.map;
  return JSON.stringify(map
    ? {version:4,mapSize:[map.width,map.height],scenes:Object.fromEntries(entries)}
    : {version:3,scenes:Object.fromEntries(entries)});
}

export function readCollisionData(raw, grids) {
  const value = JSON.parse(raw);
  if (![1, 2, 3, 4].includes(value?.version) || !value.scenes || Array.isArray(value.scenes) || typeof value.scenes !== 'object') {
    throw new Error('碰撞文件格式不正确');
  }
  const scenes = new Map();
  for (const [name, entries] of Object.entries(value.scenes)) {
    if (!Object.hasOwn(grids, name) || !Array.isArray(entries)) throw new Error('碰撞文件含未知场景');
    const {width,height,legacy}=grids[name];
    const source=name==='map' ? (value.version===4?value.mapSize:legacy??[width,height]) : [width,height];
    if (!Array.isArray(source) || source.length!==2 || !source.every(Number.isInteger) ||
        source[0]<1 || source[1]<1 || source[0]>width || source[1]>height) throw new Error('碰撞地图尺寸不兼容');
    const [sw,sh]=source;
    const indexInTarget=i=>Math.floor(i/sw)*width+i%sw;
    const cells=new Map();
    if (value.version>=3) {
      let end = 0;
      for (const run of entries) {
        if (!Array.isArray(run) || run.length !== 3 || !run.every(Number.isInteger) ||
            run[0] < end || run[1] < 1 || run[0]+run[1]>sw*sh || (run[2] !== 0 && run[2] !== 1)) {
          throw new Error('碰撞文件含无效或重叠的像素');
        }
        const [start, length, state] = run;
        end = start + length;
        for (let i=start;i<end;i+=1) cells.set(indexInTarget(i),state);
      }
    } else {
      const size = value.version === 1 && name === 'map' ? 16 : 8;
      const columns=sw/size,count=columns*sh/size;
      const seen = new Set();
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) ||
            pair[0] < 0 || pair[0] >= count || (pair[1] !== 0 && pair[1] !== 1) || seen.has(pair[0])) {
          throw new Error('碰撞文件含无效或重复的格子');
        }
        const [index, state] = pair;
        seen.add(index);
        const x = index % columns * size, y = Math.floor(index / columns) * size;
        for (let row = y; row < y + size; row += 1) {
          for (let col = x; col < x + size; col += 1) cells.set(row * width + col, state);
        }
      }
    }
    scenes.set(name, cells);
  }
  return scenes;
}

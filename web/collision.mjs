import { astar, isWalkable } from './walk.mjs';
import { pixelPath } from './asset-collision.mjs';

export const COLLISION_CELL = 1;
export const ROOM_BOUNDS = { left: 32, right: 224, top: 50, bottom: 192 };
export const ROOM_GRID = { width: 256, height: 192, cell: COLLISION_CELL };

export function collisionIndex(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
  return Math.floor(y / grid.cell) * (grid.width / grid.cell) + Math.floor(x / grid.cell);
}

export function roomAllows(cells, x, y, pixels) {
  const { left, right, top, bottom } = ROOM_BOUNDS;
  if (x < left || x > right || y < top || y > bottom) return false;
  const index = roomPixel(x, y);
  return pixels?.[index] !== 0 && cells.get(index) !== 0;
}

function roomPixel(x, y) {
  return Math.min(Math.floor(y), ROOM_BOUNDS.bottom - 1) * ROOM_GRID.width +
    Math.min(Math.floor(x), ROOM_BOUNDS.right - 1);
}

export function moveRoomFeet(cells, x, y, dx, dy, pixels) {
  const bounds = ROOM_BOUNDS;
  const initial = roomPixel(x, y);
  const clear = (px, py) => roomAllows(cells, px, py, pixels) || roomPixel(px, py) === initial;
  const steps = pixels || cells.size ? Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))) : 1;
  for (let i = 0; i < steps; i += 1) {
    const nextX = Math.max(bounds.left, Math.min(bounds.right, x + dx / steps));
    const nextY = Math.max(bounds.top, Math.min(bounds.bottom, y + dy / steps));
    if (clear(nextX, y)) x = nextX;
    if (clear(x, nextY)) y = nextY;
  }
  return [x, y];
}

// 行走器仍使用 16px 地图坐标。细网格把同一脚点换算到逐像素网格。
const mapCell = (point, scale) => Math.floor((point + 0.5) * scale);
const mapCenter = (index, scale) => (index + 0.5) / scale - 0.5;

export function mapAllows(world, x, y) {
  const grid = world.collisionGrid ?? world;
  const scale = grid.tw / world.tw;
  return isWalkable(grid, mapCell(x, scale), mapCell(y, scale));
}

export function moveMapFeet(world, x, y, dx, dy) {
  const grid = world.collisionGrid ?? world;
  const scale = grid.tw / world.tw;
  const startX = mapCell(x, scale), startY = mapCell(y, scale);
  const clear = (px, py) => {
    const tx = mapCell(px, scale), ty = mapCell(py, scale);
    // 编辑时若在角色脚下画了阻挡，仍允许角色走出这一格。
    return isWalkable(grid, tx, ty) ||
      (tx === startX && ty === startY && tx >= 0 && ty >= 0 && tx < grid.tw && ty < grid.th);
  };
  const steps = scale > 2 ? Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * scale)) : 1;
  for (let i = 0; i < steps; i += 1) {
    if (clear(x + dx / steps, y)) x += dx / steps;
    if (clear(x, y + dy / steps)) y += dy / steps;
  }
  return [x, y];
}

export function pathFromWalker(world, walker, goal) {
  const grid = world.collisionGrid ?? world;
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

export function writeCollisionData(scenes) {
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
  return JSON.stringify({ version: 3, scenes: Object.fromEntries(entries) });
}

export function readCollisionData(raw, grids) {
  const value = JSON.parse(raw);
  if (![1, 2, 3].includes(value?.version) || !value.scenes || Array.isArray(value.scenes) || typeof value.scenes !== 'object') {
    throw new Error('碰撞文件格式不正确');
  }
  const scenes = new Map();
  for (const [name, entries] of Object.entries(value.scenes)) {
    if (!Object.hasOwn(grids, name) || !Array.isArray(entries)) throw new Error('碰撞文件含未知场景');
    const { width, height } = grids[name];
    const cells = new Map();
    if (value.version === 3) {
      let end = 0;
      for (const run of entries) {
        if (!Array.isArray(run) || run.length !== 3 || !run.every(Number.isInteger) ||
            run[0] < end || run[1] < 1 || run[0] + run[1] > width * height || (run[2] !== 0 && run[2] !== 1)) {
          throw new Error('碰撞文件含无效或重叠的像素');
        }
        const [start, length, state] = run;
        end = start + length;
        for (let i = start; i < end; i += 1) cells.set(i, state);
      }
    } else {
      const size = value.version === 1 && name === 'map' ? 16 : 8;
      const columns = width / size, count = columns * height / size;
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

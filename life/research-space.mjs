// RESEARCH_ONLY：退役的空间/高度实现只在这里保留（研究夹具）。
//
// 正式游戏（life/space.mjs）本轮已经收口成唯一空间权威；下面这些实现曾经以运行时开关或
// 每帧包装的形式存在于正式路径，现在**只有研究/对照**可以用：
//   · 服务端旧地面谓词：营地内解析河 + 桥带，营地外用不带营地平整面的 wild-landscape；
//   · 客户端体半径像素栅格包装：每帧复制 world，把像素栅格按身体半径膨胀；
//   · 客户端房间像素行走：像素掩码 + 像素级逐段推进（配合 web/collision.mjs 的旧谓词）。
//
// 纪律：正式模块不得 import 本文件；scripts/arch-gates.mjs 的 ARCH-SPACE-01 会静态判红。
// 研究态（无 simClock / gameRules:false）本来就不建 space，因此保留这些夹具不会改变 dumpSurv。
import { campBridgeBounds } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { inCamp, wildLandscape } from '../shared/wild-landscape.mjs';
import { districtPads } from '../shared/camp-districts.mjs';
import { bodyGrid, CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { ROOM_BOUNDS, ROOM_GRID } from '../shared/room-layout.mjs';

export const RESEARCH_ONLY = true;

/**
 * 旧服务端地面谓词（回退开关打开时的唯一答案）。
 * 与正式 space 的差别：营地内只看解析河（不看岸线噪声），营地外用未共享营地平整面的 landscape。
 * @param {{mapSeed?:number,layoutVersion?:number,layout?:object|null,districts?:object|null}} spec
 * @returns {(x:number,z:number)=>boolean}
 */
export function legacyGroundQuery({ mapSeed = 0, layoutVersion = 0, layout = null, districts = null } = {}) {
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
  const crossZ = layout?.crossZ ?? 24;
  const bridge = layout ? campBridgeBounds(crossZ - 1, crossZ + 1, riverCenter, riverHalfWidth) : null;
  const pads = districtPads(districts);
  const terrain = wildLandscape(mapSeed, layoutVersion, { joined: true, flats: pads, clearing: pads });
  const inside = (px, pz) => bridge
    ? (px >= bridge[0] && px <= bridge[2] && pz >= bridge[1] && pz <= bridge[3]) ||
      Math.abs(px - riverCenter(pz * 16) / 16) > riverHalfWidth(pz * 16) / 16
    : Math.abs(px - riverCenter(pz * 16) / 16) > riverHalfWidth(pz * 16) / 16;
  return (x, z) => (inCamp(x, z) ? inside(x, z) : terrain.walkable(x, z, crossZ));
}

/**
 * 旧客户端体半径栅格包装：返回浅拷贝 world + 膨胀后的 pixel 栅格，不改写输入。
 * @param {object} world 需要 collisionGrid（{tw,th,walk}）
 * @param {boolean} [openEdge] 边缘格是否放行（跨区行走的旧口径）
 * @param {number} [tile] 像素/世界单位比
 */
export function legacyCampBodyWorld(world, openEdge = false, tile = 16) {
  return { ...world, collisionGrid: bodyGrid(world.collisionGrid, tile, openEdge), space: world.space ?? null };
}

const roomCell = (x, y, bounds, grid) => Math.min(Math.floor(y), bounds.bottom - 1) * grid.width +
  Math.min(Math.floor(x), bounds.right - 1);

/** 旧房间像素谓词：可行走像素边界 + 房间像素掩码（cells 覆盖层）。 */
export function legacyRoomAllows(cells, x, y, pixels, bounds = ROOM_BOUNDS, grid = ROOM_GRID) {
  const { left, right, top, bottom } = bounds;
  if (x < left || x > right || y < top || y > bottom) return false;
  const index = roomCell(x, y, bounds, grid);
  return pixels?.[index] !== 0 && cells.get(index) !== 0;
}

/** 旧房间像素逐段推进（正式室内移动已改为 roomSurface 的 16×12 世界单位空间）。 */
export function legacyMoveRoomFeet(cells, x, y, dx, dy, pixels, fits, bounds = ROOM_BOUNDS, grid = ROOM_GRID) {
  const initial = roomCell(x, y, bounds, grid);
  const clear = (px, py) => (!fits || fits(x, y, px, py)) &&
    (legacyRoomAllows(cells, px, py, pixels, bounds, grid) || roomCell(px, py, bounds, grid) === initial);
  const steps = pixels || cells.size ? Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))) : 1;
  for (let i = 0; i < steps; i += 1) {
    const nextX = Math.max(bounds.left, Math.min(bounds.right, x + dx / steps));
    const nextY = Math.max(bounds.top, Math.min(bounds.bottom, y + dy / steps));
    if (clear(nextX, y)) x = nextX;
    if (clear(x, nextY)) y = nextY;
  }
  return [x, y];
}

/**
 * 旧室内“身体贴合”判定：门列放宽到底边，按身体半径扫像素格。
 * 正式路径只问 roomSurface.walkable(x,z,CAMP_BODY_RADIUS)。
 */
export function legacyRoomBodyFits({ cells, pixels, bounds, doorX, doorWidth, x, z,
  r = CAMP_BODY_RADIUS * 16, grid = ROOM_GRID }) {
  const inDoor = x >= doorX + r && x <= doorX + doorWidth - r;
  const left = x - r, right = x + r, top = z - r, bottom = inDoor ? Math.min(z + r, bounds.bottom) : z + r;
  if (left < bounds.left || right > bounds.right || top < bounds.top || bottom > bounds.bottom) return false;
  for (let y = Math.floor(top); y <= Math.floor(bottom); y += 1) {
    for (let px = Math.floor(left); px <= Math.floor(right); px += 1) {
      if (!legacyRoomAllows(cells, px, y, pixels, bounds, grid)) return false;
    }
  }
  return true;
}

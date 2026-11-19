// P2 第一刀：唯一世界空间查询（纯模块，Node / 浏览器同构）。
//
// 原则：1 世界单位 = 1 tile = 16 像素；本模块不画图、不读 DOM、不持有时钟。
// 输入是现有几何的**适配器**（camp stage/floors + wild-landscape），不是重写：
//   · 营地地面：campTerrain 的河道 + hash2 岸线噪声（与 web/app.js terrainKinds 同一条公式）；
//   · 桥：campBridgeBounds（与客户端 bridgeCells 同一条）；桥面高度来自 stage.floors；
//   · 碰撞：stage.boxes.filter(solid) 的 AABB（含 bounds，旋转件也走 modelBounds）；
//   · 高度：stage.floors（floorContains），房间地板显式 0；
//   · 门户：stage.entrances（campEntrance）+ 桥带；房间区域显式 16×12，不再靠隐式 /16 判位置。
//
// 服务端 construction-access 与客户端玩家移动都走这里；旧实现保留为 fallback 开关：
//   · 服务端 env SPACE_V1=0；客户端 ?space=legacy 或 globalThis.__SPACE_LEGACY__=true。
import { campTerrain, floorContains, hash2 } from '../shared/camp-terrain.mjs';
import { campBridgeBounds, TOWN_SIZE } from '../shared/camp-layout.mjs';
import { modelBounds } from '../shared/camp-geometry.mjs';
import { inCamp } from '../shared/wild-landscape.mjs';
import { ROOM_DOOR_WORLD, ROOM_UNITS } from '../shared/room-layout.mjs';

export const TILE = 16;
export const PIXELS_PER_UNIT = 16;
export const CAMP_UNITS = Object.freeze({ width: TOWN_SIZE.width, depth: TOWN_SIZE.depth });

// ── 时间/速度：正式游戏唯一口径（单位/游戏分钟）─────────────────────────────
// 客户端手感基线：0.5 tile/帧 × 6fps = 3 单位/秒；默认 1 游戏分钟 = 125ms（60 分/7.5s 刻）。
// 因此正式游戏基础步行速度 = 3 / 8 = 0.375 单位/游戏分钟；冲刺 ×1.75。
// 服务端 playerReach 的每刻预算、客户端每帧步长、居民 startMove 全部由这两个函数派生。
export const GAME_MINUTES_PER_TICK = 60;
export const WALK_UNITS_PER_GAME_MINUTE = 3 / 8;
export const SPRINT_FACTOR = 1.75;
export const GAME_BASE_UNITS_PER_TICK = WALK_UNITS_PER_GAME_MINUTE * GAME_MINUTES_PER_TICK;
export const GAME_PLAYER_UNITS_PER_TICK = GAME_BASE_UNITS_PER_TICK * SPRINT_FACTOR;
export const unitsForGameMinutes = (minutes) => WALK_UNITS_PER_GAME_MINUTE * minutes;
export const unitsForTick = (sprint = false) =>
  unitsForGameMinutes(GAME_MINUTES_PER_TICK) * (sprint ? SPRINT_FACTOR : 1);
// P2b：唯一“每游戏分钟多少单位”的预算表。玩家移动上报、居民旅行、客户端步长全部从这里派生。
export const SPEED_BUDGET_UNITS_PER_GAME_MINUTE = Object.freeze({
  walk: WALK_UNITS_PER_GAME_MINUTE,
  sprint: WALK_UNITS_PER_GAME_MINUTE * SPRINT_FACTOR,
});
export const speedBudget = (kind = 'walk') =>
  kind === 'sprint' ? SPEED_BUDGET_UNITS_PER_GAME_MINUTE.sprint : SPEED_BUDGET_UNITS_PER_GAME_MINUTE.walk;
export const unitsPerTick = (kind = 'walk') => speedBudget(kind) * GAME_MINUTES_PER_TICK;
// 同一路径的刻数：居民旅行与玩家移动用同一函数。+1 是到点缓冲（旧 startMove 的保守口径）。
export const travelTicks = (distance, kind = 'sprint', min = 2) =>
  Math.max(min, Math.ceil(Math.max(0, distance) / unitsPerTick(kind)) + 1);
// 正式游戏居民与玩家共用同一预算表：居民按 walk（22.5/刻）出行；玩家移动上报可冲刺
// （sprint 39.375/刻）。两者都由 speedBudget/unitsPerTick 派生，不再有独立常数 12。
export const GAME_RESIDENT_UNITS_PER_TICK = unitsPerTick('walk');
// tickMs 只决定“一刻的真实时长”；游戏分钟→真实时间的换算必须与宿主一致。
export const unitsForRealMs = (ms, tickMs = 7500, sprint = false) => {
  const minutes = GAME_MINUTES_PER_TICK * (Number.isFinite(ms) ? ms : 0) /
    Math.max(1, Number.isFinite(tickMs) ? tickMs : 7500);
  return unitsForGameMinutes(minutes) * (sprint ? SPRINT_FACTOR : 1);
};

// ── 房间：显式 16×12 世界单位（原服务端 pointIn(from,16.01,12.01) 的等价物）─────────
// P2c：房间几何与门都在 shared/room-layout.mjs；这里只把 roomStage 的实体 AABB 包成
// 与营地/野外同构的空间查询。像素画布（256×192）只在渲染与旧路径里出现。
export { ROOM_UNITS };
export const ROOM_CONTAINS_EPS = 0.01;
export const ROOM_FLOOR_Y = 0;
export const roomContains = (x, z) => Number.isFinite(x) && Number.isFinite(z) &&
  x >= 0 && x < ROOM_UNITS.width + ROOM_CONTAINS_EPS &&
  z >= 0 && z < ROOM_UNITS.height + ROOM_CONTAINS_EPS;
export const roomToWorld = (p) => ({ x: p[0] / PIXELS_PER_UNIT, z: p[1] / PIXELS_PER_UNIT });
export const worldToRoom = (p) => ({ x: p.x * PIXELS_PER_UNIT, z: p.z * PIXELS_PER_UNIT });

/**
 * 房间空间：16×12 世界单位，门是唯一出路。
 * walkable 复刻旧 roomBodyFits：可行走矩形按身体半径收缩；门宽范围允许脚点贴到底边。
 * @param {{room?:string, stage?:object, bounds?:object, door?:object, extraSolids?:Array}} spec
 */
export function roomSurface({ room = null, stage = null, bounds = null, door = null, extraSolids = [] } = {}) {
  const b = bounds ?? stage?.walkBounds ?? { left: 2, right: 14, top: 1.65, bottom: 12 };
  const portal = door
    ? { x: door.x, z: door.z, w: door.w, d: door.d }
    : { ...ROOM_DOOR_WORLD };
  const colliders = [];
  for (const box of stage?.boxes ?? []) { const c = toCollider(box); if (c) colliders.push(c); }
  for (const box of extraSolids) { const c = toCollider({ ...box, solid: true }, 'room-solid'); if (c) colliders.push(c); }
  const index = indexColliders(colliders);
  const portalRect = Object.freeze(portal);
  function walkable(x, z, r = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const radius = Number.isFinite(r) ? Math.max(0, r) : 0;
    // 门只放宽"脚点贴到底边"（旧 roomBodyFits 的口径），绝不放宽到 16×12 之外。
    if (z > b.bottom + 1e-9) return false;
    const left = x - radius, right = x + radius;
    const top = z - radius;
    const inDoor = x >= portalRect.x + radius && x <= portalRect.x + portalRect.w - radius;
    const bottom = inDoor ? Math.min(z + radius, b.bottom) : z + radius;
    if (left < b.left || right > b.right || top < b.top || bottom > b.bottom) return false;
    return nearColliders(index, colliders, x, z, radius).length === 0;
  }
  function portalAt(x, z, r = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const radius = Number.isFinite(r) ? Math.max(0, r) : 0;
    return rectGap(x, z, portalRect) <= radius
      ? Object.freeze({ id: 'door:' + (room ?? 'room'), kind: 'door', room, rect: portalRect, a: 'room:' + room, b: 'outside' })
      : null;
  }
  return Object.freeze({
    room, bounds: Object.freeze({ ...b }), door: portalRect, colliders,
    walkable,
    portalAt,
    heightAt: () => ROOM_FLOOR_Y,
    collidersNear: (x, z, r = 0) => nearColliders(index, colliders, x, z, r),
  });
}

const smooth = (t) => t * t * (3 - 2 * t);

// 与 web/app.js terrainKinds 的 noiseField(24) 逐点等价（不预烘焙整张图）。
function edgeNoise(seed, x, y, scale = 24) {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const u = smooth(fx - ix), v = smooth(fy - iy);
  const s = 11 + seed;
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s);
  const c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

function toCollider(b, fallbackKind = 'solid') {
  if (!b || b.solid !== true) return null;
  const bounds = b.bounds ?? modelBounds(b);
  if (!bounds || !(bounds.w > 0) || !(bounds.d > 0)) return null;
  return Object.freeze({
    x: bounds.x, z: bounds.z, w: bounds.w, d: bounds.d,
    kind: b.occluder ?? b.kind ?? fallbackKind,
    occluder: b.occluder ?? null,
  });
}

// 均匀网格索引：collidersNear 不再每次扫全表。
function indexColliders(colliders, cell = 8) {
  const cells = new Map();
  for (let i = 0; i < colliders.length; i += 1) {
    const c = colliders[i];
    const x0 = Math.floor(c.x / cell), x1 = Math.floor((c.x + c.w) / cell);
    const z0 = Math.floor(c.z / cell), z1 = Math.floor((c.z + c.d) / cell);
    for (let gx = x0; gx <= x1; gx += 1) for (let gz = z0; gz <= z1; gz += 1) {
      const key = gx + ',' + gz;
      const list = cells.get(key);
      if (list) list.push(i); else cells.set(key, [i]);
    }
  }
  return { cell, cells };
}

const rectGap = (x, z, r) => Math.hypot(
  Math.max(r.x - x, 0, x - r.x - r.w),
  Math.max(r.z - z, 0, z - r.z - r.d));

function nearColliders(index, colliders, x, z, radius = 0) {
  const out = [], seen = new Set();
  const { cell, cells } = index;
  const r = Math.max(0, Number.isFinite(radius) ? radius : 0);
  const gx0 = Math.floor((x - r) / cell), gx1 = Math.floor((x + r) / cell);
  const gz0 = Math.floor((z - r) / cell), gz1 = Math.floor((z + r) / cell);
  for (let gx = gx0; gx <= gx1; gx += 1) for (let gz = gz0; gz <= gz1; gz += 1) {
    for (const i of cells.get(gx + ',' + gz) ?? []) {
      if (seen.has(i)) continue;
      seen.add(i);
      const c = colliders[i];
      if (rectGap(x, z, c) <= r + 1e-9) out.push(c);
    }
  }
  out.sort((a, b) => a.x - b.x || a.z - b.z || String(a.kind).localeCompare(String(b.kind)));
  return out;
}

function floorHeight(floors, x, z) {
  let y = 0;
  for (const f of floors) {
    if (!floorContains(f, x, z)) continue;
    if (f.triangle) {
      y = Math.max(y, f.y + f.ax * (x - f.x) + f.az * (z - f.z));
      continue;
    }
    const t = f.axis === 'x' ? (x - f.x) / f.w : f.axis === 'z' ? (z - f.z) / f.d : 0;
    y = Math.max(y, f.y + (f.end - f.y) * t);
  }
  return y;
}

/**
 * 营地适配器：只读现有 stage/floors + 共享河道公式。
 * @param {object} spec
 * @param {number} spec.mapSeed
 * @param {number} spec.layoutVersion
 * @param {object|null} spec.layout   camp layout（提供 crossZ）
 * @param {object|null} spec.stage    outdoorStage()/roomStage() 结果（boxes/floors/entrances）
 * @param {number} [spec.raised]      campTerrain 的 raised（营地= true）
 * @param {Array}  [spec.bridges]     campBridgeBounds 结果数组；缺省按 layout.crossZ ±1
 * @param {Array}  [spec.extraSolids] 额外 AABB
 */
export function campSurface({ mapSeed = 0, layoutVersion = 0, layout = null, stage = null,
  raised = true, bridges = null, extraSolids = [] } = {}) {
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, raised, layoutVersion);
  const crossing = layout?.crossZ ?? 24;
  const bridgeList = bridges ?? (layout
    ? [campBridgeBounds(crossing - 1, crossing + 1, riverCenter, riverHalfWidth)]
    : []);
  const bridgeTiles = new Set();
  for (const [x0, z0, x1, z1] of bridgeList) {
    for (let tx = Math.floor(x0); tx < Math.ceil(x1); tx += 1) {
      for (let tz = Math.floor(z0); tz < Math.ceil(z1); tz += 1) bridgeTiles.add(tx + ',' + tz);
    }
  }
  const onBridge = (x, z) => bridgeTiles.has(Math.floor(x) + ',' + Math.floor(z));

  function classify(x, z) {
    if (onBridge(x, z)) return 'bridge';
    const px = x * PIXELS_PER_UNIT, pz = z * PIXELS_PER_UNIT;
    const wet = riverHalfWidth(pz) - Math.abs(px - riverCenter(pz));
    if (wet >= 0) return 'water';
    const rough = edgeNoise(mapSeed, px, pz) * 2 - 1;
    if (wet > -3 - rough) return 'bank';
    return 'grass';
  }
  const terrainAllows = (x, z) => {
    if (onBridge(x, z)) return true;
    const px = x * PIXELS_PER_UNIT, pz = z * PIXELS_PER_UNIT;
    const wet = riverHalfWidth(pz) - Math.abs(px - riverCenter(pz));
    const rough = edgeNoise(mapSeed, px, pz) * 2 - 1;
    return wet <= -3 - rough;
  };

  const boxes = stage?.boxes ?? [];
  const colliders = [];
  for (const b of boxes) { const c = toCollider(b); if (c) colliders.push(c); }
  for (const b of extraSolids) { const c = toCollider({ ...b, solid: true }, 'extra'); if (c) colliders.push(c); }
  const index = indexColliders(colliders);
  const portals = [
    ...Object.entries(stage?.entrances ?? {}).filter(([, rect]) => rect && rect.w > 0 && rect.d > 0)
      .map(([room, rect]) => Object.freeze({
        id: 'door:' + room, kind: 'door', room, rect: Object.freeze({ x: rect.x, z: rect.z, w: rect.w, d: rect.d }),
        a: 'room:' + room, b: 'outside',
      })),
    ...bridgeList.map(([x0, z0, x1, z1], i) => Object.freeze({
      id: 'bridge:' + i, kind: 'bridge',
      rect: Object.freeze({ x: x0, z: z0, w: x1 - x0, d: z1 - z0 }),
      a: 'west-bank', b: 'east-bank',
    })),
  ].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const floors = stage?.floors ?? [];

  return Object.freeze({
    crossing, raised, bridgeList, portals, colliders,
    classify,
    terrainAllows,
    heightAt: (x, z) => floorHeight(floors, x, z),
    collidersNear: (x, z, r = 0) => nearColliders(index, colliders, x, z, r),
    portalAt(x, z, r = 0) {
      return portals.find((p) => rectGap(x, z, p.rect) <= Math.max(0, r)) ?? null;
    },
  });
}

/**
 * 野外适配器：包住现有 wildLandscape，不重算地形。
 */
export function wildSurface(landscape, { crossing = 24, solids = [], height = null } = {}) {
  if (!landscape) return null;
  const colliders = solids.map((b) => toCollider({ ...b, solid: true }, 'wild')).filter(Boolean);
  const index = indexColliders(colliders);
  return Object.freeze({
    crossing, colliders,
    walkable: (x, z) => Boolean(landscape.walkable(x, z, crossing)),
    height: (x, z) => (height ? height(x, z) : landscape.height(x, z)),
    collidersNear: (x, z, r = 0) => nearColliders(index, colliders, x, z, r),
  });
}

/**
 * 唯一空间查询。camp 负责营地矩形内；wild 负责矩形外；rooms 是显式室内空间工厂。
 * @param {{camp?:object|null,wild?:object|null,crossing?:number,rooms?:object|Function|null}} spec
 */
export function createSpace({ camp = null, wild = null, crossing = null, rooms = null } = {}) {
  const colliders = [...(camp?.colliders ?? []), ...(wild?.colliders ?? [])];
  const index = indexColliders(colliders);
  const cross = crossing ?? camp?.crossing ?? wild?.crossing ?? 24;
  const isCamp = (x, z) => Boolean(camp) && inCamp(x, z);
  const collidersNear = (x, z, r = 0) => nearColliders(index, colliders, x, z, r);

  function walkable(x, z, r = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (isCamp(x, z)) {
      if (!camp.terrainAllows(x, z)) return false;
    } else {
      if (!wild || !wild.walkable(x, z)) return false;
    }
    return collidersNear(x, z, r).length === 0;
  }
  function terrainWalkable(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (isCamp(x, z)) return camp.terrainAllows(x, z);
    return Boolean(wild?.walkable?.(x, z));
  }
  function heightAt(x, z) {
    if (isCamp(x, z)) return camp.heightAt(x, z);
    return wild?.height?.(x, z) ?? 0;
  }
  // 房间仍是区域：显式给 room 时用房间地板高度（0），不再靠 /16 反推。
  function roomHeightAt(x, z, room) {
    if (room && roomContains(x, z)) return ROOM_FLOOR_Y;
    return heightAt(x, z);
  }
  function roomPortal(room) {
    return camp?.portals?.find((p) => p.kind === 'door' && p.room === room) ?? null;
  }
  function portalAt(x, z, r = 0) {
    return camp?.portalAt?.(x, z, r) ?? null;
  }
  function surface(x, z, r = 0) {
    const region = isCamp(x, z) ? 'camp' : 'wild';
    const kind = region === 'camp' ? camp.classify(x, z) : 'wild';
    return {
      x, z, region, kind,
      y: heightAt(x, z),
      walkable: walkable(x, z, r),
      solid: collidersNear(x, z, 0).length > 0,
      room: null,
    };
  }
  function roomSpace(room) {
    if (typeof rooms === 'function') return rooms(room);
    return (rooms && rooms[room]) ?? null;
  }
  return Object.freeze({
    crossing: cross,
    camp, wild,
    colliders,
    walkable, heightAt, roomHeightAt, roomPortal, collidersNear, portalAt, surface, terrainWalkable,
    roomSpace, roomContains,
  });
}

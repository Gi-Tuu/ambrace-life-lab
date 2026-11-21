// P2/P4：唯一世界空间查询（纯模块，Node / 浏览器同构）。
//
// 原则：1 世界单位 = 1 tile = 16 像素；本模块不画图、不读 DOM、不持有时钟。
// 正式游戏里 heightAt / walkable / collidersNear / portalAt 只有这一个来源，没有运行时开关：
//   · 地形高度：campTerrain + wild-landscape 的 joined 高度链（村内地面与野外同一条），
//     客户端 buildWorld 与刷新后的服务端用的是同一份 content.landscape；
//   · stage.floors 只注册“可站表面/建筑地板”（桥面、连廊、房间地板），不再是第二个地形高度源；
//     组合规则唯一：max(0, 地形链高度, 已注册表面高度) —— 村内/野外同一公式，见 campSurface.heightAt
//     与 createSpace.heightAt；
//   · 营地地面分类：campTerrain 的河道 + hash2 岸线噪声（与 web/app.js terrainKinds 同一条公式）；
//   · 桥：campBridgeBounds（与客户端 bridgeCells 同一条）；桥面是 stage.floors 里的可站表面；
//   · 碰撞：stage.boxes.filter(solid) 的 AABB（含 bounds，旋转件也走 modelBounds）；
//   · 房间：显式 16×12 体积 + 唯一门 portal（roomSurface），室内移动只走它；
//   · 门户：stage.entrances（campEntrance）+ 桥带；房间区域显式 16×12，不再靠隐式 /16 判位置。
//
// 退役的旧实现（服务端旧地面回退谓词、客户端每帧包裹像素栅格的体半径包装、房间像素行走）
// 只在 test-support/legacy-space-oracle.mjs 里作为测试 oracle 保留；运行路径 0 import。
import { campTerrain, floorHeight, floorSurface, hash2 } from '../shared/camp-terrain.mjs';
import { campBridgeBounds, TOWN_SIZE } from '../shared/camp-layout.mjs';
import { modelBounds } from '../shared/camp-geometry.mjs';
import { inCamp } from '../shared/wild-landscape.mjs';
import { ROOM_DOOR_WORLD, ROOM_UNITS } from '../shared/room-layout.mjs';

export const TILE = 16;
export const PIXELS_PER_UNIT = 16;
export const CAMP_UNITS = Object.freeze({ width: TOWN_SIZE.width, depth: TOWN_SIZE.depth });

// ── 时间/速度：正式游戏唯一口径（单位/游戏分钟）─────────────────────────────
// 正式默认 1 游戏分钟 = 6000ms（1:10，一天 144 现实分钟），即一刻 60 分 = 360000ms。
// 因此正式游戏基础步行速度 = 0.375 单位/游戏分钟；冲刺 ×1.75。现实耗时随 1:10 变长是预期。
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
// 同一路径的刻数：居民旅行与玩家移动用同一公式。+1 是到点缓冲（旧 startMove 的保守口径）。
export const travelTicksAt = (distance, perTick, min = 2) =>
  Math.max(min, Math.ceil(Math.max(0, distance) / perTick) + 1);
export const travelTicks = (distance, kind = 'sprint', min = 2) =>
  travelTicksAt(distance, unitsPerTick(kind), min);
// 正式游戏居民与玩家共用同一预算表：居民按 walk（22.5/刻）出行；玩家移动上报可冲刺
// （sprint 39.375/刻）。两者都由 speedBudget/unitsPerTick 派生，不再有独立常数 12。
export const GAME_RESIDENT_UNITS_PER_TICK = unitsPerTick('walk');

// ── 研究态 legacy 速度行（唯一配置，不是第二套空间）─────────────────────────
// 研究态/旧时间模型没有连续路径与 space 几何，但仍是一种“每刻走多少单位”的预算；
// 数值与 researchTravelTicks 已收口到 life/research-policy.mjs（唯一策略模块）。
// space.mjs 是浏览器也 import 的纯几何模块，不能反向依赖服务端策略（否则 /life/ 模块 404）。
// 旧空间实现（地面谓词/体半径像素栅格/房间像素行走）已迁到 test-support/legacy-space-oracle.mjs，
// 运行路径 0 import；ARCH-SPACE-01 / ARCH-RESEARCH-01 静态钉死。
// tickMs 只决定“一刻的真实时长”；正式默认 60 游戏分/刻 × 6000ms = 360000ms。
// 调用方必须传与当前世界 clock 同源的 tickMs；默认值只是正式口径兜底，不是第二套时间源。
export const DEFAULT_TICK_MS = 360000;
export const unitsForRealMs = (ms, tickMs = DEFAULT_TICK_MS, sprint = false) => {
  const minutes = GAME_MINUTES_PER_TICK * (Number.isFinite(ms) ? ms : 0) /
    Math.max(1, Number.isFinite(tickMs) ? tickMs : DEFAULT_TICK_MS);
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
 * walkable 复刻旧室内贴合判定：可行走矩形按身体半径收缩；门宽范围允许脚点贴到底边。
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
    // 门只放宽"脚点贴到底边"（旧室内贴合判定的口径），绝不放宽到 16×12 之外。
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

/**
 * 营地适配器：只读现有 stage/floors + 共享河道公式。
 * @param {object} spec
 * @param {number} spec.mapSeed
 * @param {number} spec.layoutVersion
 * @param {object|null} spec.layout   camp layout（提供 crossZ）
 * @param {object|null} spec.stage    outdoorStage()/roomStage() 结果（boxes/floors/entrances）
 * @param {{height?:Function}|null} [spec.terrain] 地形链（camp-outskirts/wild-landscape）；缺省时只有 stage 表面
 * @param {number} [spec.raised]      campTerrain 的 raised（营地= true）
 * @param {Array}  [spec.bridges]     campBridgeBounds 结果数组；缺省按 layout.crossZ ±1
 * @param {Array}  [spec.extraSolids] 额外 AABB
 */
export function campSurface({ mapSeed = 0, layoutVersion = 0, layout = null, stage = null,
  terrain = null, raised = true, bridges = null, extraSolids = [] } = {}) {
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, raised, layoutVersion);
  // 桥带是画出来的那份（content.bridges），不是按 crossZ 再推一次：
  // 旧写法在 layout=null（默认存档）时 bridgeList=[]、crossing 兜底 24，桥只画在 mesh 里、
  // 行走层当水处理 —— 东岸 0 格可达。现在桥带优先用调用方传入的 content.bridges，
  // crossing 由桥带反推（与 campBridgeBounds(first,last) 的 z0..z1 一致），layout 只作兼容兜底。
  const layoutCrossing = layout?.crossZ ?? null;
  const bridgeList = bridges ?? (layout
    ? [campBridgeBounds(layoutCrossing - 1, layoutCrossing + 1, riverCenter, riverHalfWidth)]
    : []);
  const crossing = layoutCrossing ?? (bridgeList.length
    ? Math.round((bridgeList[0][1] + bridgeList[0][3]) / 2 - .5)
    : 24);
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
    crossing, raised, bridgeList, portals, colliders, floors,
    classify,
    terrainAllows,
    // 已注册的可站表面/建筑地板（桥面、连廊、房间地板）。只回答“表面比地面高多少”，
    // 不当地形基座：地图地坪由 terrain 链给。
    surfaceHeight: (x, z) => floorHeight(floors, x, z),
    // 唯一高度组合（村内/野外同一公式）：max(0, 地形链, 已注册表面)。
    // 0 是地面基准面：河床/洼地的负高度不参与脚底高度，避免村内与野外出现两套口径。
    // 没有 terrain 时只剩表面（纯几何单测；正式路径必须给 terrain）。
    heightAt: (x, z) => {
      const base = terrain?.height?.(x, z) ?? 0;
      return Math.max(0, base, floorSurface(floors, x, z) ?? 0);
    },
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
 * terrain 是唯一地形链（camp-outskirts/wild-landscape 的 joined 高度）；camp/wild 必须由它派生。
 * @param {{camp?:object|null,wild?:object|null,terrain?:object|null,crossing?:number,rooms?:object|Function|null}} spec
 */
export function createSpace({ camp = null, wild = null, terrain = null, crossing = null, rooms = null } = {}) {
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
    // 野外与营地同一条公式：max(0, 地形链)。野外没有可站表面，只叠地面基准面。
    const base = wild?.height ? wild.height(x, z) : (terrain?.height?.(x, z) ?? 0);
    return Math.max(0, base);
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
    camp, wild, terrain,
    colliders,
    walkable, heightAt, roomHeightAt, roomPortal, collidersNear, portalAt, surface, terrainWalkable,
    roomSpace, roomContains,
  });
}

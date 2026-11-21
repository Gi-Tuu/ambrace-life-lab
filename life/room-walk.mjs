// 1.2 B：居民室内自由移动（只修表现与可观察位置）。
//
// 口径：
//   · 事实：居民在房间空间里的位置仍是唯一写入口 placeActor 写的 w.pos（space='room:<id>'）；
//   · 只用 roomSurface.walkable(..., CAMP_BODY_RADIUS) 判定能不能站/能不能走；墙/家具/门因此同一份几何；
//   · **不改 loc/occupancy/动作/需求/决策**：本模块只在每分钟给 room 空间里的居民挪 w.pos；
//   · 兴趣点从房间家具（roomPropsPx）来：床/桌/火炉/长凳/工作台/水井/门…，取家具外一个可站点；
//   · 多人：目标点按 id 确定性分配，移动时与同房间其他人保持分离；被占/被堵就换下一个兴趣点；
//   · 玩家（p1）不动；研究态/旧时间模型没有 w.pos，本模块不被调用。
//   · 出房仍按既有 portal：startMove 把位置切到房间门的世界点；进房由 body.settleTravel 落在门内点，
//     随后由这里走到兴趣点（同门连续，不再从村外直接出现在屋子中间）。
import { hash2 } from '../shared/camp-terrain.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { HOUSING_PLOTS } from '../shared/camp-layout.mjs';
import { ROOM_DOOR_WORLD, roomPropsPx } from '../shared/room-layout.mjs';
import { isAlive } from './viability.mjs';
import { roomSpaceOf } from './construction-access.mjs';
import { isRoomSpace, placeActor, posOf, roomOfSpace, roomSpaceId } from './actor-pos.mjs';
import { WALK_UNITS_PER_GAME_MINUTE } from './space.mjs';

// 家具在世界单位里的近似外框（只用来找“家具外的可站点”，不作为碰撞来源）。
const PROP_SIZE = Object.freeze({
  bed: [1.86, 1.22], table: [2.1, 1.2], hearth: [1.5, 1.0], bench: [1.9, .8], shelf: [1.56, 1.1],
  workbench: [1.8, 1.0], anvil: [1.4, 1.2], furnace: [1.4, 1.2], telescope: [1.4, 1.4],
  well: [1.9, 1.7], planter: [1.3, 1.2], rug: [2.6, 1.8], barrel: [.8, .8], crate: [.9, .9],
  grain: [.9, .9], bucket: [.6, .6], cart: [2.3, 1.4], fence: [1.7, .5], trellis: [1.6, .6],
  banner: [.9, .5], default: [1.6, 1.1],
});
// 兴趣点：会走过去并停留的家具（不是所有装饰）。
const INTEREST = new Set(['bed', 'table', 'hearth', 'bench', 'shelf', 'workbench', 'anvil', 'furnace', 'telescope', 'well', 'planter', 'grain']);
const SEPARATION = CAMP_BODY_RADIUS * 2 + .02;
const NEED2 = (CAMP_BODY_RADIUS * 2) ** 2;
const STEP = WALK_UNITS_PER_GAME_MINUTE;

// 室内避让的严格版 separates：不重叠的身体距离是硬约束（不“挤过去”）；
// 已经重叠时只允许把距离拉开的步子（用于自愈/多人同点入场）。
function roomSeparates(from, to, others) {
  for (const other of others) {
    const before = (from[0] - other.x) ** 2 + (from[1] - other.z) ** 2;
    const after = (to[0] - other.x) ** 2 + (to[1] - other.z) ** 2;
    if (after < NEED2 - 1e-9 && !(before < NEED2 && after > before + 1e-9)) return false;
  }
  return true;
}

const poiCache = new WeakMap();
const walkCaches = new WeakMap();

/** 房间兴趣点（每世界每房间缓存；认领/家具变化由 roomSpaceOf 的 key 兜底）。 */
export function roomPois(world, room) {
  if (!world || typeof room !== 'string') return [];
  let perWorld = poiCache.get(world);
  if (!perWorld) { perWorld = new Map(); poiCache.set(world, perWorld); }
  const facility = room.startsWith('facility:') ? room.split(':')[2] : null;
  const personal = Boolean(world.peripheralHomes?.[room]) || Object.hasOwn(HOUSING_PLOTS, room);
  const key = [room, world.mapSeed ?? 0, world.layoutVersion ?? 0, world.campLayout ? 1 : 0, personal ? 1 : 0, facility ?? '', Boolean(world.homeAccess?.[room])].join('|');
  const hit = perWorld.get(room);
  if (hit && hit.key === key) return hit.pois;
  const space = roomSpaceOf(world, room);
  if (!space) return [];
  const points = [];
  const addPoint = (kind, x, z) => {
    if (!space.walkable(x, z, CAMP_BODY_RADIUS)) return;
    points.push({ kind, x, z });
  };
  // 门：房内门口是对所有房间都成立的兴趣点。
  addPoint('door', ROOM_DOOR_WORLD.x + ROOM_DOOR_WORLD.w / 2, ROOM_DOOR_WORLD.z + ROOM_DOOR_WORLD.d - .35);
  for (const [kind, px, py] of roomPropsPx(room, { personal, facility })) {
    if (!INTEREST.has(kind)) continue;
    const [w, d] = PROP_SIZE[kind] ?? PROP_SIZE.default;
    const cx = px / 16 + w / 2, cz = py / 16 + d / 2;
    const radius = Math.max(w, d) / 2 + .45;
    const dirs = [[0, 1], [1, 0], [-1, 0], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]];
    for (const [dx, dz] of dirs) {
      const len = Math.hypot(dx, dz);
      addPoint(kind, cx + dx / len * radius, cz + dz / len * radius);
    }
  }
  const pois = points.length ? points : [{ kind: 'door', x: 8, z: 11.2 }];
  perWorld.set(room, { key, pois });
  return pois;
}

function stableIndex(world, id, salt, n) {
  const seed = (world.mapSeed ?? 0) + 131;
  const idx = (id ?? '').split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return Math.floor(hash2(idx + salt, n, seed) * n) % n;
}

// 同房间的其他居民/玩家位置（避让与占位）。
function roomNeighbors(world, room, id) {
  const out = [];
  for (const [other, pos] of Object.entries(world.pos ?? {})) {
    if (other === id) continue;
    if (other !== 'p1' && !isAlive(world.agents?.[other])) continue;
    if (!isRoomSpace(pos?.space) || roomOfSpace(pos.space) !== room) continue;
    out.push({ id: other, x: pos.x, z: pos.z });
  }
  return out;
}

function walkState(world) {
  let actors = walkCaches.get(world);
  if (!actors) { actors = new Map(); walkCaches.set(world, actors); }
  return actors;
}

function chooseTarget(world, id, room, pois, neighbors, current, from, offset = 0) {
  const claimed = new Set();
  for (const other of neighbors) {
    const st = walkState(world).get(other.id);
    if (st?.room === room && Number.isInteger(st.poi)) claimed.add(st.poi);
  }
  const nearOthers = (x, z) => roomSeparates(from, [x, z], neighbors);
  const n = pois.length;
  // start 每轮前进一格（offset = 已选次数）：同一居民不会只在家具 A/B 两点间往返。
  const start = (stableIndex(world, id, room.length, n) + offset) % n;
  for (let i = 0; i < n; i += 1) {
    const idx = (start + i) % n;
    if (idx === current) continue;
    if (claimed.has(idx) && n > claimed.size + 1) continue;
    const poi = pois[idx];
    // 目标点已经站了别人（且自己不会因此拉开距离）⇒ 换下一个（多人占位）。
    if (!nearOthers(poi.x, poi.z)) continue;
    return idx;
  }
  // 所有兴趣点都被占：退到不会继续贴近别人的那个点，先散开再说。
  for (let i = 0; i < n; i += 1) {
    const idx = (start + i) % n;
    if (nearOthers(pois[idx].x, pois[idx].z)) return idx;
  }
  return Number.isInteger(current) && current >= 0 && current < n ? current : start;
}

/**
 * 居民室内移动的每分钟一步。返回本分钟实际移动的人数（测试/观测用）。
 * 只写 w.pos；不碰 loc/occupancy/动作。
 */
export function stepRoomWalk(world, minute = 0) {
  const s = world?.survival;
  if (!world?.pos || s?.actTimeModel !== true) return 0;
  const groups = new Map();
  for (const [id, pos] of Object.entries(world.pos)) {
    if (id === 'p1' || world.agents?.[id]?.isPlayer || !isAlive(world.agents?.[id])) continue;
    if (!isRoomSpace(pos?.space) || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
    const room = roomOfSpace(pos.space);
    if (!groups.has(room)) groups.set(room, []);
    groups.get(room).push(id);
  }
  let moved = 0;
  const actors = walkState(world);
  for (const [room, ids] of groups) {
    const space = roomSpaceOf(world, room);
    if (!space) continue;
    const pois = roomPois(world, room);
    ids.sort();
    for (const id of ids) {
      const pos = posOf(world, id);
      const neighbors = roomNeighbors(world, room, id);
      let st = actors.get(id);
      if (!st || st.room !== room) {
        st = { room, poi: -1, idleUntil: -1, stuck: 0, last: -1 };
        actors.set(id, st);
      }
      if (minute < st.idleUntil) continue;
      if (st.poi < 0 || !pois[st.poi]) {
        st.visits = (st.visits ?? 0) + 1;
        st.poi = chooseTarget(world, id, room, pois, neighbors, Number.isInteger(st.last) ? st.last : -1, [pos.x, pos.z], st.visits);
      }
      const target = pois[st.poi];
      const dx = target.x - pos.x, dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= STEP + 1e-9) {
        if (!space.walkable(target.x, target.z, CAMP_BODY_RADIUS) ||
            !roomSeparates([pos.x, pos.z], [target.x, target.z], neighbors)) {
          st.poi = chooseTarget(world, id, room, pois, neighbors, st.poi, [pos.x, pos.z]);
          st.stuck = 0;
          continue;
        }
        if (dist > 1e-6) {
          placeActor(world, id, { x: target.x, z: target.z, space: roomSpaceId(room) });
          moved += 1;
        }
        // 到了就停 0–1 游戏分钟再换兴趣点（约 0–6 现实秒），避免整屋不停打转，
        // 又保证任意 10 现实秒窗口里至少能看到一次位置变化。
        st.idleUntil = minute + (hash2(minute, st.poi, (world.mapSeed ?? 0) + 7) > .45 ? 1 : 0);
        st.last = st.poi;
        st.poi = -1;
        st.stuck = 0;
        continue;
      }
      const ux = dx / dist, uz = dz / dist;
      const tries = [[ux, uz], [ux, 0], [0, uz]];
      let next = null;
      for (const [mx, mz] of tries) {
        const len = Math.hypot(mx, mz);
        if (len < 1e-9) continue;
        const nx = pos.x + mx / len * STEP, nz = pos.z + mz / len * STEP;
        if (!space.walkable(nx, nz, CAMP_BODY_RADIUS)) continue;
        if (!roomSeparates([pos.x, pos.z], [nx, nz], neighbors)) continue;
        next = [nx, nz];
        break;
      }
      if (!next) {
        st.stuck += 1;
        if (st.stuck >= 2) {
          st.poi = chooseTarget(world, id, room, pois, neighbors, st.poi, [pos.x, pos.z]);
          st.stuck = 0;
        }
        continue;
      }
      placeActor(world, id, { x: next[0], z: next[1], space: roomSpaceId(room) });
      moved += 1;
      st.stuck = 0;
    }
  }
  return moved;
}

/**
 * 进房落点：门内可站的一点（与门外门点同一个门，位置连续），避让同房间的人。
 * 玩家不走这里（玩家室内位置仍由客户端/portal 自己管）。
 */
export function roomEntryPosition(world, room, id = null) {
  if (typeof room !== 'string' || !room) return null;
  const space = roomSpaceOf(world, room);
  if (!space) return null;
  const base = { x: ROOM_DOOR_WORLD.x + ROOM_DOOR_WORLD.w / 2, z: ROOM_DOOR_WORLD.z + ROOM_DOOR_WORLD.d - .35 };
  const others = id ? roomNeighbors(world, room, id) : [];
  for (const [dx, dz] of [[0, 0], [.45, 0], [-.45, 0], [.9, 0], [-.9, 0], [0, -.5]]) {
    const x = base.x + dx, z = base.z + dz;
    if (!space.walkable(x, z, CAMP_BODY_RADIUS)) continue;
    if (others.some((o) => Math.hypot(o.x - x, o.z - z) < SEPARATION)) continue;
    return { x, z, space: roomSpaceId(room) };
  }
  return null;
}

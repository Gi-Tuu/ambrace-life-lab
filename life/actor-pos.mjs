// P2c：角色位置的唯一事实与唯一写入口。
//
// 事实：w.pos[id] = {x,z,space}
//   · space='world'      —— 营地/野外世界单位（1 = 1 tile = 16px）
//   · space='room:<id>'  —— 房间内坐标（0..16, 0..12），房间是独立空间，不是 /16 隐式换算
//
// 派生索引（都有且只有一个写入口，见本文件）：
//   · w.loc[id] / w.occupancy —— 地点键与占用索引（感知、候选、A/B 对照仍按原顺序读它）
//   · w.survival.playerPos / w.campPlayerRoom —— 玩家镜像，写 pos 时同步，旧代码/回放只读
//   · w.survival.districtTravel / w.residentTravel —— 旅行索引，由 beginTravel/advanceIndex/clearTravel 写
//   · constructionArrivals —— survView 每次从 residentTravel 现算，不是存储字段
//
// 研究态/旧时间模型（actTimeModel!==true）不创建 w.pos，也不改任何旧字段语义：
// 旧路径继续直接写 loc/occupancy，dumpSurv 因此逐位不变。
import { worldSite } from './geometry.mjs';
import { HOUSING_PLOTS } from '../shared/camp-layout.mjs';
import { ROOM_INTERIORS } from '../shared/room-layout.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';

export const WORLD_SPACE = 'world';
export const roomSpaceId = (room) => 'room:' + room;
export const isRoomSpace = (space) => typeof space === 'string' && space.startsWith('room:');
export const roomOfSpace = (space) => (isRoomSpace(space) ? space.slice(5) : null);
export const formalPositions = (w) => w?.survival?.actTimeModel === true;
export const posOf = (w, id) => w?.pos?.[id] ?? null;

// 与 web/app.js roomCrowd 同一张槽位表（客户端室内站位）；服务端用同一 roomSurface 过滤。
const ROOM_SLOTS = Object.freeze([[6, 9], [9.6, 9], [5.65, 5.4], [9.45, 5.4], [4, 9], [11.7, 9], [6.7, 7.3], [9.6, 7.3]]);
export function roomSlots(space) {
  if (!space) return ROOM_SLOTS;
  return ROOM_SLOTS.filter(([x, z]) => space.walkable(x, z, CAMP_BODY_RADIUS));
}
export function isInteriorLoc(w, loc) {
  if (typeof loc !== 'string' || !loc) return false;
  return Object.hasOwn(ROOM_INTERIORS, loc) || Object.hasOwn(HOUSING_PLOTS, loc) ||
    Boolean(w?.peripheralHomes?.[loc]) || loc.startsWith('facility:');
}

export function defaultWorldPos(w, loc, index = 0) {
  const at = worldSite(w, loc);
  if (!at) return { x: 0, z: 0, space: WORLD_SPACE };
  // 与客户端 slotsOf 同式：同一 location 的第 i 个人落在锚点左下/右侧。
  return { x: at[0] - 1 + (index % 3), z: at[1] + Math.floor(index / 3), space: WORLD_SPACE };
}

export function defaultActorPos(w, id, loc, { roomSpace = null, index = 0 } = {}) {
  if (isInteriorLoc(w, loc)) {
    const space = typeof roomSpace === 'function' ? roomSpace(loc) : null;
    const slots = roomSlots(space);
    const slot = slots[index % slots.length] ?? [8, 11.5];
    return { x: slot[0], z: slot[1], space: roomSpaceId(loc) };
  }
  return defaultWorldPos(w, loc, index);
}

function occupancyRemove(w, id) {
  for (const ids of Object.values(w.occupancy ?? {})) {
    const at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1);
  }
}

function writeLoc(w, id, to) {
  const from = w.loc[id];
  if (from === to) return false;
  if (from !== undefined && w.occupancy?.[from]) w.occupancy[from] = w.occupancy[from].filter((x) => x !== id);
  (w.occupancy[to] ??= []).push(id);
  w.loc[id] = to;
  return true;
}

// 玩家镜像：只在这里写 survival.playerPos / campPlayerRoom。
function mirrorPlayer(w, pos) {
  if (!w.survival) return;
  w.survival.playerPos = { x: pos.x, z: pos.z, t: w.t };
  w.campPlayerRoom = isRoomSpace(pos.space) ? roomOfSpace(pos.space) : null;
}

/**
 * 唯一位置写入口。调用方给的 pos 必须已经在目标空间里（world 或 room:<id>）。
 * loc 缺省时不改地点索引；room 缺省时从 pos.space 推。
 */
export function placeActor(w, id, pos, { loc = undefined, room = undefined, mirror = false } = {}) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return posOf(w, id);
  const space = pos.space ?? (room ? roomSpaceId(room) : WORLD_SPACE);
  const next = { x: pos.x, z: pos.z, space };
  (w.pos ??= {})[id] = next;
  if (loc !== undefined) writeLoc(w, id, loc);
  if (mirror && id === 'p1') mirrorPlayer(w, next);
  return next;
}

/**
 * 旧档/新档的位置恢复：只接受格式合法的条目，其余交给 initPositions 按 loc 补。
 * 旧档（P2b 及以前）没有 pos，本函数是空操作。
 */
export function adoptPositions(w, raw) {
  if (!formalPositions(w)) return w.pos ?? null;
  // 读档是"整体替换"而不是叠加：旧档没有 pos 时必须清掉 createSurvPlay 在内存里先建的默认位置，
  // 再由 initPositions 按存档的 loc/playerPos 重算（否则旧档会被新建世界的槽位顶掉）。
  w.pos = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return w.pos;
  for (const [id, p] of Object.entries(raw)) {
    if (id !== 'p1' && !w.agents?.[id]) continue;
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z) || typeof p.space !== 'string') continue;
    w.pos[id] = { x: p.x, z: p.z, space: p.space };
  }
  return w.pos;
}

/**
 * 新建/读档后的位置初始化：已有 pos 不动；没有就按 loc/占用序号确定性补一个。
 * @param {{roomSpace?:Function|null}} options
 */
export function initPositions(w, { roomSpace = null, playerPos = true } = {}) {
  if (!formalPositions(w)) return w.pos ?? null;
  w.pos ??= {};
  for (const [id, loc] of Object.entries(w.loc ?? {})) {
    if (id === 'p1' || !w.agents?.[id] || w.pos[id]) continue;
    const index = Math.max(0, (w.occupancy?.[loc] ?? []).indexOf(id));
    // 旧档：正在/刚完成外围行程的人，residentTravel.at 才是他最后被服务端认可的外围脚点。
    const arrival = w.residentTravel?.[id];
    if (id !== 'p1' && arrival?.to === loc && Array.isArray(arrival.at) &&
        Number.isFinite(arrival.at[0]) && Number.isFinite(arrival.at[1])) {
      w.pos[id] = { x: arrival.at[0], z: arrival.at[1], space: WORLD_SPACE };
      continue;
    }
    // 玩家只有 campPlayerRoom 存在时才算"在室内"；居民的地点本身就是房间（客户端室内视图）。
    const indoor = isInteriorLoc(w, loc) && !(id === 'p1' && !w.campPlayerRoom);
    w.pos[id] = indoor
      ? defaultActorPos(w, id, loc, { roomSpace, index })
      : defaultWorldPos(w, loc, index);
  }
  const p1 = w.agents?.p1;
  const saved = playerPos ? w.survival?.playerPos : null;
  if (p1 && w.loc.p1 && !w.pos.p1) {
    const index = Math.max(0, (w.occupancy?.[w.loc.p1] ?? []).indexOf('p1'));
    w.pos.p1 = Number.isFinite(saved?.x) && Number.isFinite(saved?.z)
      ? { x: saved.x, z: saved.z, space: w.campPlayerRoom ? roomSpaceId(w.campPlayerRoom) : WORLD_SPACE }
      : (w.campPlayerRoom
        ? defaultActorPos(w, 'p1', w.loc.p1, { roomSpace, index })
        : defaultWorldPos(w, w.loc.p1, index));
  }
  // 旧档：playerPos 存在但 campPlayerRoom 丢失时仍按室外解释，不把室内坐标当世界坐标放大。
  if (p1 && w.campPlayerRoom && w.pos.p1 && !isRoomSpace(w.pos.p1.space)) {
    w.pos.p1 = { ...w.pos.p1, space: roomSpaceId(w.campPlayerRoom) };
  }
  return w.pos;
}

/**
 * 地点变化。pos 由调用方给（portal/旅行结算必须显式给）；否则按新地点确定性补。
 */
export function moveActor(w, id, to, { pos = null, roomSpace = null, mirror = false } = {}) {
  const from = w.loc[id];
  if (from === to) return { moved: false, pos: posOf(w, id) };
  if (!formalPositions(w)) { writeLoc(w, id, to); return { moved: true, pos: null }; }
  const index = (w.occupancy?.[to] ?? []).length;
  const next = pos ?? defaultActorPos(w, id, to, { roomSpace, index });
  writeLoc(w, id, to);
  placeActor(w, id, next, { mirror });
  return { moved: true, pos: next };
}

export function spawnActor(w, id, loc, { roomSpace = null } = {}) {
  w.loc[id] = loc;
  (w.occupancy[loc] ??= []).push(id);
  if (formalPositions(w)) {
    const index = w.occupancy[loc].length - 1;
    placeActor(w, id, defaultActorPos(w, id, loc, { roomSpace, index }));
  }
}

export function removeActor(w, id) {
  occupancyRemove(w, id);
}

// 只解除"玩家在室内"的镜像，不改位置（死亡/终局用）。
export function detachPlayerRoom(w) {
  if (w?.survival) w.campPlayerRoom = null;
  return w;
}

// 只改玩家房间镜像（读档恢复/自愈用；位置仍由 adoptPositions/initPositions 收口）。
export function setPlayerRoom(w, room) {
  if (w?.survival) w.campPlayerRoom = room ?? null;
  return w;
}

// 只改地点键（读档自愈/研究夹具用）；占用索引随后由 rebuildOccupancy 统一重建。
export function setLocOnly(w, id, loc) {
  w.loc ??= {};
  w.loc[id] = loc;
  return w;
}

/** 读档/快照恢复后重建占用索引（loc 是权威，occupancy 保序）。 */
export function rebuildOccupancy(w, order = null) {
  const expected = {};
  for (const [id, loc] of Object.entries(w.loc ?? {})) {
    if (!loc || w.agents?.[id]?.dead) continue;
    (expected[loc] ??= []).push(id);
  }
  if (order && typeof order === 'object') {
    const keys = Object.keys(order).filter((k) => (order[k] ?? []).length);
    let ok = keys.length === Object.keys(expected).length;
    if (ok) for (const k of keys) {
      const arr = order[k];
      if (!Array.isArray(arr) || arr.length !== (expected[k] ?? []).length || new Set(arr).size !== arr.length ||
          !arr.every((x) => w.loc[x] === k && !w.agents?.[x]?.dead)) { ok = false; break; }
    }
    w.occupancy = ok
      ? Object.fromEntries(Object.entries(order).map(([k, arr]) => [k, Array.isArray(arr) ? arr.slice() : []]))
      : expected;
  } else {
    w.occupancy = expected;
  }
  return w.occupancy;
}

// 旧档位置迁移的单一入口：先按存档 pos（若有）整体恢复，再按 loc/槽位/playerPos 补齐。
export function migratePositions(w, rawPos = null) {
  adoptPositions(w, rawPos);
  return initPositions(w);
}

// ── 旅行索引：读侧仍然是 districtTravel/residentTravel 的旧字段 ──────────────
export function travelOf(w, id) {
  return w.survival?.districtTravel?.[id] ?? null;
}
export function beginTravel(w, id, row) {
  (w.survival.districtTravel ??= {})[id] = row;
  return row;
}
export function setTravelAt(w, id, at) {
  const row = w.survival?.districtTravel?.[id];
  if (row) row.at = at;
  return row ?? null;
}
export function clearTravel(w, id) {
  const row = w.survival?.districtTravel?.[id] ?? null;
  if (row) delete w.survival.districtTravel[id];
  return row;
}
export function noteArrival(w, id, from, to) {
  (w.residentTravel ??= {})[id] = { from, to, t: w.t };
}

/** 读档恢复旅行索引（旧字段仍是客户端动画/施工到点的读取口）。 */
export function adoptTravels(w, residentTravel, districtTravel) {
  if (residentTravel && typeof residentTravel === 'object') w.residentTravel = structuredClone(residentTravel);
  if (districtTravel && typeof districtTravel === 'object') w.survival.districtTravel = structuredClone(districtTravel);
  return { residentTravel: w.residentTravel ?? null, districtTravel: w.survival?.districtTravel ?? null };
}
export function travelStartWorld(w, id, { roomDoor = null } = {}) {
  const pos = posOf(w, id);
  if (pos && isRoomSpace(pos.space)) {
    const door = roomDoor ? roomDoor(roomOfSpace(pos.space)) : null;
    return { point: door ? [door[0], door[1]] : null, fromRoom: roomOfSpace(pos.space) };
  }
  if (pos && pos.space === WORLD_SPACE) return { point: [pos.x, pos.z], fromRoom: null };
  return { point: null, fromRoom: null };
}

// 旅行推进：返回本刻是否到达。路径是 worldRoute 的返回（首点可能已吸附到窗口格）。
export function advanceTravelPos(w, id, row, budget) {
  let remain = Math.max(0, budget);
  let { x, z } = row.cursor ?? { x: row.start[0], z: row.start[1] };
  const path = row.path ?? [];
  let index = row.index ?? 0;
  while (index < path.length && remain > 0) {
    const [tx, tz] = path[index];
    const dx = tx - x, dz = tz - z, dist = Math.hypot(dx, dz);
    if (dist <= remain + 1e-9) { x = tx; z = tz; remain -= dist; index += 1; }
    else { x += dx / dist * remain; z += dz / dist * remain; remain = 0; }
  }
  row.cursor = { x, z };
  row.index = index;
  row.progress = index;
  placeActor(w, id, { x, z, space: WORLD_SPACE });
  return { arrived: index >= path.length, x, z };
}

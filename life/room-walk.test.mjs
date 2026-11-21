// 1.2 B 闸门：居民室内自由移动（只写 w.pos；roomSurface 可走性；多人避让；进出门连续；玩家/研究态不变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSurvPlay, tickSurvPlay, survView } from './survplay.mjs';
import { stepRoomWalk, roomPois, roomStepBudget, ROOM_WALK_SUBSTEP } from './room-walk.mjs';
import { roomSpaceOf, roomDoorPoint } from './construction-access.mjs';
import { settleTravel, startMove, advanceTravels } from './body.mjs';
import { registerWildClaim } from '../shared/wild-plots.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { unitsPerTick, WALK_UNITS_PER_GAME_MINUTE } from './space.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const OPT = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
  wildExpansion: true, eventRulesVersion: CURRENT_EVENT_RULES,
};
const SLOTS = [[6, 9], [9.6, 9], [5.65, 5.4]];
const IDS = ['a1', 'a2', 'a3'];
function indoor(seed = 13, extra = {}, room = 'home') {
  const sp = createSurvPlay(seed, { ...OPT, mapSeed: seed, ...extra });
  const w = sp.world;
  w.survival.districtTravel = {};
  IDS.forEach((id, i) => { w.loc[id] = room; w.pos[id] = { x: SLOTS[i][0], z: SLOTS[i][1], space: 'room:' + room }; });
  w.occupancy[room] = [...IDS];
  return { sp, w, space: roomSpaceOf(w, room) };
}
const separation = (w) => {
  let min = Infinity;
  for (let i = 0; i < IDS.length; i += 1) for (let j = i + 1; j < IDS.length; j += 1) {
    min = Math.min(min, Math.hypot(w.pos[IDS[i]].x - w.pos[IDS[j]].x, w.pos[IDS[i]].z - w.pos[IDS[j]].z));
  }
  return min;
};

test('V12-ROOM-01 10 秒内位置变化：2 游戏分（1:10 下 ≈10 现实秒）内每个居民都移动且每一步可站', () => {
  const { w, space } = indoor();
  const before = Object.fromEntries(IDS.map((id) => [id, { ...w.pos[id] }]));
  const loc = JSON.stringify(w.loc), occ = JSON.stringify(w.occupancy);
  for (let minute = 1; minute <= 2; minute += 1) {
    stepRoomWalk(w, minute);
    for (const id of IDS) {
      const p = w.pos[id];
      assert.equal(space.walkable(p.x, p.z, CAMP_BODY_RADIUS), true, `第 ${minute} 分 ${id} 站到墙/家具里：${JSON.stringify(p)}`);
      assert.equal(space.collidersNear(p.x, p.z, CAMP_BODY_RADIUS).length, 0, `${id} 与家具/墙重叠`);
      assert.ok(p.x > 0 && p.x < 16 && p.z > 0 && p.z <= 12, '必须留在 16×12 房间内');
    }
  }
  for (const id of IDS) {
    const moved = Math.hypot(w.pos[id].x - before[id].x, w.pos[id].z - before[id].z);
    assert.ok(moved > 0.05, `${id} 在 10 秒窗口内没有移动（${moved}）`);
  }
  // 只修表现与可观察位置：loc/占用不动。
  assert.equal(JSON.stringify(w.loc), loc);
  assert.equal(JSON.stringify(w.occupancy), occ);
});

test('V12-ROOM-02 长时间走动：始终不穿模、多人保持身体分离、访问 ≥2 个兴趣点', () => {
  const { w, space } = indoor();
  const pois = roomPois(w, 'home');
  const kinds = new Set();
  const visited = Object.fromEntries(IDS.map((id) => [id, new Set()]));
  let minSep = Infinity;
  for (let minute = 1; minute <= 240; minute += 1) {
    stepRoomWalk(w, minute);
    minSep = Math.min(minSep, separation(w));
    for (const id of IDS) {
      const p = w.pos[id];
      assert.equal(space.walkable(p.x, p.z, CAMP_BODY_RADIUS), true, `第 ${minute} 分 ${id} 位置不可站`);
      assert.equal(space.collidersNear(p.x, p.z, CAMP_BODY_RADIUS).length, 0);
      pois.forEach((poi) => {
        if (Math.hypot(poi.x - p.x, poi.z - p.z) < 0.4) { visited[id].add(poi.kind); kinds.add(poi.kind); }
      });
    }
    assert.ok(separation(w) >= CAMP_BODY_RADIUS * 2 - 1e-6, `第 ${minute} 分钟居民重叠：${separation(w)}`);
  }
  assert.ok(minSep >= CAMP_BODY_RADIUS * 2 - 1e-6, `最小间距 ${minSep}`);
  for (const id of IDS) assert.ok(visited[id].size >= 2, `${id} 只访问了 ${[...visited[id]]}`);
  assert.ok(kinds.size >= 2, `兴趣点种类 ${[...kinds]}`);
});

test('V12-ROOM-03 只写 w.pos：loc/占用/动作轨迹/需求都不变（玩家在室内也不动）', () => {
  const { w, space } = indoor();
  w.campPlayerRoom = 'hall';
  w.loc.p1 = 'hall';
  w.occupancy.hall = ['p1'];
  w.pos.p1 = { x: 8.2, z: 11.3, space: 'room:hall' };
  const before = {
    loc: JSON.stringify(w.loc), occ: JSON.stringify(w.occupancy),
    energy: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, a.drives?.v?.energy])),
    trace: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, a.trace?.length ?? 0])),
    p1: { ...w.pos.p1 },
  };
  for (let minute = 1; minute <= 60; minute += 1) stepRoomWalk(w, minute);
  assert.deepEqual(w.pos.p1, before.p1, '玩家室内位置不得被居民走动改掉');
  assert.equal(JSON.stringify(w.loc), before.loc);
  assert.equal(JSON.stringify(w.occupancy), before.occ);
  for (const a of Object.values(w.agents)) {
    assert.equal(a.drives?.v?.energy, before.energy[a.id], `${a.id} 需求被改了`);
    assert.equal(a.trace?.length ?? 0, before.trace[a.id], `${a.id} 动作轨迹被写了`);
  }
  assert.ok(space.walkable(8.2, 11.3, CAMP_BODY_RADIUS));
});

test('V12-ROOM-04 进出门连续：进房落在门内可站点；出房切到同一扇门的世界点后逐刻连续', () => {
  const sp = createSurvPlay(13, OPT);
  const w = sp.world;
  const room = w.housing.a1; // 居民自己的家（初始 a1 → house2）
  const before = w.loc.a1;
  // 模拟一次回房：目的地是这个房间，到达刻结算。
  const at = w.campLayout.sites[room] ?? w.peripheralHomes?.[room] ?? null;
  settleTravel(w, 'a1', { from: before, to: room, path: [[at[0], at[1]]], arrive: w.t, cursor: { x: at[0], z: at[1] } });
  assert.equal(w.loc.a1, room, '到达后才同步 loc');
  assert.equal(w.pos.a1.space, 'room:' + room);
  const space = roomSpaceOf(w, room);
  assert.equal(space.walkable(w.pos.a1.x, w.pos.a1.z, CAMP_BODY_RADIUS), true, '进门落点必须可站');
  const doorWorld = { x: 8, z: 11.65 };
  assert.ok(Math.hypot(w.pos.a1.x - doorWorld.x, w.pos.a1.z - doorWorld.z) < 1.2, '进门必须落在门内附近（与门外门点连续）');
  // 出房：位置切到同一扇门的世界点，随后按 speedBudget 逐刻推进，不瞬移。
  // 目的地用刚认领的荒野宅基地（同村落近郊，路由在每刻预算内稳定可达）。
  const wild = survView(sp).wildPlots.plots[0];
  registerWildClaim(w, wild.id, wild, 'p1');
  startMove(w, 'a1', wild.id);
  assert.equal(w.pos.a1.space, 'world');
  assert.deepEqual([w.pos.a1.x, w.pos.a1.z], roomDoorPoint(w, room), '出门位置必须等于该房间门的世界点');
  const row = w.survival.districtTravel.a1;
  assert.ok(Array.isArray(row.path) && row.path.length > 0);
  let prev = [w.pos.a1.x, w.pos.a1.z], maxStep = 0, guard = 0;
  while (w.survival.districtTravel.a1 && guard < 120) {
    w.t += 1;
    advanceTravels(w);
    const p = w.pos.a1;
    if (p.space === 'world') {
      const step = Math.hypot(p.x - prev[0], p.z - prev[1]);
      maxStep = Math.max(maxStep, step);
      prev = [p.x, p.z];
    }
    guard += 1;
  }
  assert.ok(guard < 120, '旅行必须到达');
  assert.ok(maxStep <= unitsPerTick('walk') + 1e-6, `单刻位移 ${maxStep} 超过预算`);
  assert.ok(Math.hypot(prev[0] - roomDoorPoint(w, room)[0], prev[1] - roomDoorPoint(w, room)[1]) > 1, '确实离开门口走远');
});

test('V12-ROOM-05 生产路径接电：连续钟每游戏分推进室内位置（tickSurvPlay）', async () => {
  const sp = createSurvPlay(13, { ...OPT, simTime: true, minuteMetab: true });
  const w = sp.world;
  w.survival.districtTravel = {};
  const homes = { a1: w.housing.a1, a2: w.housing.a2, a3: w.housing.a3 };
  for (const [id, room] of Object.entries(homes)) {
    w.loc[id] = room;
    w.pos[id] = { x: 8, z: 11.2, space: 'room:' + room };
    w.occupancy[room] = [id];
    // 只验“分钟推进确实接到室内走动”：把决策环钉住，避免 AI 把人带去别处（这是测试夹具，不是产品逻辑）。
    w.agents[id].nextThinkMin = Infinity;
  }
  const before = Object.fromEntries(Object.entries(homes).map(([id]) => [id, { ...w.pos[id] }]));
  await tickSurvPlay(sp, { minutes: 3 });
  let moved = 0;
  for (const [id, room] of Object.entries(homes)) {
    if (w.loc[id] !== room) continue; // 决策环把人带走了不算本闸门
    const space = roomSpaceOf(w, room);
    assert.equal(space.walkable(w.pos[id].x, w.pos[id].z, CAMP_BODY_RADIUS), true, `${id} 室内位置不可站`);
    if (Math.hypot(w.pos[id].x - before[id].x, w.pos[id].z - before[id].z) > 0.05) moved += 1;
  }
  assert.ok(moved >= 1, '连续钟推进 3 游戏分后必须至少有一名室内居民移动');
});

test('V12-ROOM-06 研究态/旧时间模型不变：没有 pos，步进是空操作；可走性闸门有牙（家具内不可站）', () => {
  const lab = createSurvPlay(7, {});
  assert.equal(lab.world.pos, undefined);
  assert.equal(stepRoomWalk(lab.world, 1), 0);
  const { w, space } = indoor();
  // 家具内部本来就不能站：闸门若被绕过（直接写进床/桌），上面的 walkable 断言会红。
  assert.ok(space.colliders.length > 0, '房间必须有家具实体');
  const solid = space.colliders.find((c) => c.w >= .6 && c.d >= .6) ?? space.colliders[0];
  assert.equal(space.walkable(solid.x + solid.w / 2, solid.z + solid.d / 2, 0), false, '家具内部必须不可站');
  assert.equal(stepRoomWalk(w, 1) >= 0, true);
  // 2026-11-21 位移修复：步长不再 0.375（旧 125ms/游戏分的标定）；室内也按真实 3 tile/s，
  // 正式 6000ms/游戏分 ⇒ 每游戏分钟 18 tile、0.25 tile 一子步。
  assert.equal(roomStepBudget(w), 18);
  assert.equal(ROOM_WALK_SUBSTEP, 0.25);
  assert.ok(Math.abs(WALK_UNITS_PER_GAME_MINUTE - 0.375) < 1e-12, '游戏分钟预算表本身仍在（只服务动作/旅行语义）');
});

test('V12-ROOM-07 真实 10 秒室内位移、每子步可站、不穿墙、A/B 一致', () => {
  // 10 现实秒 ≈ 2 游戏分（1:10）；室内预算 18 tile/分、0.25 tile 一子步。
  const A = indoor(), B = indoor();
  const locA = JSON.stringify(A.w.loc), occA = JSON.stringify(A.w.occupancy);
  const samples = [];
  const posSnapshot = () => Object.fromEntries(IDS.map((id) => [id, { ...A.w.pos[id] }]));
  const same = (a, b) => IDS.every((id) =>
    a[id].x === b[id].x && a[id].z === b[id].z && a[id].space === b[id].space);
  for (const next of [A, B]) assert.equal(roomStepBudget(next.w), 18, '正式/夹具都按 1:10 的 18 tile/游戏分');

  for (let minute = 1; minute <= 2; minute += 1) {
    stepRoomWalk(A.w, minute, { onStep: (row) => samples.push(row) });
    stepRoomWalk(B.w, minute);
    assert.ok(same(posSnapshot(), Object.fromEntries(IDS.map((id) => [id, { ...B.w.pos[id] }]))),
      `第 ${minute} 分 A/B 室内位置必须逐位一致`);
  }

  // 子步：每个落点都必须站得住、在房间内、步长 ≤0.25，且同一时刻与同屋其他人不重叠。
  const path = Object.fromEntries(IDS.map((id) => [id, 0]));
  const visitedKinds = new Set();
  const pois = roomPois(A.w, 'home');
  let prev = null;
  for (const row of samples) {
    const space = roomSpaceOf(A.w, row.room);
    assert.equal(space.walkable(row.x, row.z, CAMP_BODY_RADIUS), true, `${row.id} 子步站到墙/家具里`);
    assert.ok(row.x > 0 && row.x < 16 && row.z > 0 && row.z <= 12, `${row.id} 子步离开 16×12 房间`);
    assert.ok(row.step > 0 && row.step <= ROOM_WALK_SUBSTEP + 1e-9, `子步步长必须 ≤${ROOM_WALK_SUBSTEP}（实测 ${row.step}）`);
    if (prev && prev.id === row.id) {
      const d = Math.hypot(row.x - prev.x, row.z - prev.z);
      path[row.id] += d;
      assert.ok(d <= ROOM_WALK_SUBSTEP + 1e-9, `子步位移 ${d} 超过 0.25`);
    }
    if (prev && prev.id !== row.id) prev = null;
    prev = row;
    for (const [p, q] of [['a1', 'a2'], ['a1', 'a3'], ['a2', 'a3']]) {
      const d = Math.hypot(A.w.pos[p].x - A.w.pos[q].x, A.w.pos[p].z - A.w.pos[q].z);
      assert.ok(d >= CAMP_BODY_RADIUS * 2 - 1e-6, `${row.id} 子步导致 ${p}/${q} 重叠：${d}`);
    }
    for (const poi of pois) if (Math.hypot(poi.x - row.x, poi.z - row.z) < 0.4) visitedKinds.add(poi.kind);
  }
  // 10 秒窗口：至少一名居民走 ≥5 tile，或这间屋访问到 ≥2 种兴趣点（按房间实际可达）。
  const maxPath = Math.max(...IDS.map((id) => path[id]));
  assert.ok(maxPath >= 5 || visitedKinds.size >= 2,
    `10 秒室内位移必须明显（路径 ${IDS.map((id) => `${id}:${path[id].toFixed(2)}`)}，兴趣点 ${[...visitedKinds]}）`);
  // 只写 pos：loc/占用不动。
  assert.equal(JSON.stringify(A.w.loc), locA);
  assert.equal(JSON.stringify(A.w.occupancy), occA);
});

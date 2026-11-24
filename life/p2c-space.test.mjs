// P2c 闸门：唯一位置事实（含旧档迁移与唯一写入口）、显式房间空间/portal、
// 居民连续路径推进、玩家/居民同一 speedBudget、穿墙/越界拒绝、A* 单入口、研究态不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSurvPlay, dumpSurv, loadSurv, survView, survAct } from './survplay.mjs';
import { startMove, advanceTravels } from './body.mjs';
import { playerReach } from './survplay-camp.mjs';
import { roomSpaceOf, roomDoorPoint, constructionSpace, sceneSpace } from './construction-access.mjs';
import { GAME_BASE_UNITS_PER_TICK, GAME_PLAYER_UNITS_PER_TICK, unitsPerTick, roomSurface } from './space.mjs';
import { worldRoute, routeLength } from '../shared/asset-collision.mjs';
import { joinedRoute } from '../shared/camp-outskirts.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { astar } from '../web/walk.mjs';
import { roomPropsPx, ROOM_DOOR_WORLD, ROOM_UNITS, hallFrontGeometry } from '../shared/room-layout.mjs';
import { roomStage, homeStyle } from '../shared/camp-scene.mjs';
import { isRoomSpace, placeActor, posOf } from './actor-pos.mjs';
import { worldSite } from './geometry.mjs';
import { campEntrance } from '../shared/camp-interaction.mjs';

const FORMAL = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
};
const start = (seed = 13, extra = {}) => createSurvPlay(seed, { ...FORMAL, mapSeed: seed, ...extra });
const LIFE_DIR = fileURLToPath(new URL('.', import.meta.url));

test('P2c-01 唯一位置事实：正式游戏每人有 pos；研究态没有 pos 且 dump 不含位置', () => {
  const sp = start(), w = sp.world;
  assert.ok(w.pos, '正式游戏必须有 w.pos');
  for (const id of Object.keys(w.agents)) {
    const p = w.pos[id];
    assert.ok(p, `${id} 缺位置`);
    assert.ok(p.space === 'world' || isRoomSpace(p.space), `${id} 的 space 必须显式`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  }
  // 玩家只有 campPlayerRoom 时才在房间空间；居民的地点本身就是房间。
  assert.equal(w.pos.p1.space, 'world');
  assert.equal(w.pos.a1.space, 'room:home');
  assert.equal(survView(sp).agents.a1.pos.x, w.pos.a1.x);
  const dump = dumpSurv(sp);
  assert.ok(dump.pos?.a1, '正式游戏 pos 入档');
  // 研究态：不建 pos、不入档。
  const lab = createSurvPlay(7);
  assert.equal(lab.world.pos, undefined, '研究态不创建位置事实');
  assert.equal(JSON.stringify(dumpSurv(lab)).includes('"pos"'), false);
});

test('P2c-02 旧档迁移：没有 pos 时按 loc/槽位/playerPos/residentTravel.at 确定性补齐', () => {
  const sp = start(), w = sp.world;
  const site = w.campLayout.sites.hall;
  w.campPlayerRoom = 'hall';
  w.loc.p1 = 'hall';
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  const district = Object.keys(w.districts)[0];
  const at = w.districts[district].at;
  w.loc.a2 = district;
  w.residentTravel = { a2: { from: 'home', to: district, t: 0, at: [at[0], at[1]] } };
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  delete raw.pos; // 模拟 P2b 及以前的旧档
  const back = loadSurv(raw, 13, FORMAL).world;
  assert.deepEqual(back.pos.p1, { x: 8, z: 11.5, space: 'room:hall' }, '玩家室内坐标不得乘 16');
  assert.equal(back.pos.a1.space, 'room:home', '居民从 home 地点补房间空间');
  assert.deepEqual(back.pos.a2, { x: at[0], z: at[1], space: 'world' }, '行程到点的居民用 residentTravel.at');
  assert.deepEqual(back.survival.playerPos, { x: 8, z: 11.5, t: w.t }, 'playerPos 镜像逐位恢复');
  assert.equal(back.campPlayerRoom, 'hall');
  // 再存再读：pos 原样往返。
  const twice = loadSurv(JSON.parse(JSON.stringify(dumpSurv(loadSurv(raw, 13, FORMAL)))), 13, FORMAL).world;
  assert.deepEqual(twice.pos, back.pos, 'pos 迁移必须幂等');
  // 唯一写入口：placeActor 一次写 pos + loc + 玩家镜像。
  placeActor(back, 'p1', { x: 9, z: 11.4, space: 'room:hall' }, { mirror: true });
  assert.equal(back.loc.p1, 'hall');
  assert.deepEqual(back.survival.playerPos, { x: 9, z: 11.4, t: back.t });
});

test('P2c-03 静态闸门：旧位置字段只在 actor-pos/迁移/研究快照适配里被写', () => {
  const ALLOW = new Set([
    'actor-pos.mjs',        // 唯一写入口
    'host-world.mjs',       // 研究/城镇快照恢复（非 survival 存档）
    'camp-instances.mjs',   // forkCamp 的 survival 夹具
    'build-efficiency.mjs', // 离线消融夹具
    'capability.mjs',       // 离线能力实验夹具
  ]);
  const WRITE = [
    /\.loc\[[^\]]+\]\s*=(?!=)/,
    /\.loc\.p1\s*=(?!=)/,
    /\.occupancy\[[^\]]*\]\s*=(?!=)/,
    /\.occupancy\s*=(?!=)/,
    /\.playerPos\s*=(?!=)/,
    /\.campPlayerRoom\s*=(?!=)/,
    /\.residentTravel\s*=(?!=)/,
    /\.residentTravel\[[^\]]+\]\s*=(?!=)/,
    /\.districtTravel\s*=(?!=)/,
    /\.districtTravel\[[^\]]+\]\s*=(?!=)/,
  ];
  const bad = [];
  for (const name of readdirSync(LIFE_DIR)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    if (ALLOW.has(name)) continue;
    const lines = readFileSync(LIFE_DIR + name, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (WRITE.some((re) => re.test(line))) bad.push(`${name}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(bad, [], `旧位置字段被独立写入：\n${bad.join('\n')}`);
  // P4：室内只有 roomSurface（16×12 世界空间）；旧像素行走/体半径判定必须彻底消失。
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /roomSpaceFor\(/);
  assert.match(app, /roomSurface\(/);
  assert.match(app, /ROOM_DOOR_REACH/);
  assert.match(app, /label:doorGap<=ROOM_DOOR_REACH\/TILE\?'F 离开':'出口'/);
  assert.doesNotMatch(app, /space\.portalAt\([^\n]+closeRoom\(\)/,
    '室内走近门不得自动出门；进出统一按 F');
  assert.match(app, /moveRoomSurface\(/);
  assert.equal(/roomPixelWalk|moveRoomFeet|roomBodyFits|roomAllows|SPACE_LEGACY/.test(app), false,
    '正式室内路径仍含旧像素实现');
});

test('P2c-04 房间是显式 16×12 世界空间：门 portal、墙/家具/越界拒绝', () => {
  const sp = start(), w = sp.world;
  const hall = roomSpaceOf(w, 'hall');
  assert.ok(hall);
  assert.deepEqual([ROOM_UNITS.width, ROOM_UNITS.height], [16, 12]);
  assert.deepEqual(hall.door, { ...ROOM_DOOR_WORLD });
  assert.equal(hall.walkable(8, 11.5, CAMP_BODY_RADIUS), true, '门口可站');
  assert.equal(hall.portalAt(8, 11.9, .2)?.kind, 'door');
  assert.equal(hall.portalAt(8, 11.9, .2)?.room, 'hall');
  assert.equal(hall.walkable(0.5, 6, CAMP_BODY_RADIUS), false, '左墙');
  assert.equal(hall.walkable(15.5, 6, CAMP_BODY_RADIUS), false, '右墙');
  assert.equal(hall.walkable(8, 1.0, CAMP_BODY_RADIUS), false, '后墙');
  assert.equal(hall.walkable(2, 12.4, CAMP_BODY_RADIUS), false, '越出 16×12');
  assert.equal(hall.walkable(8, 12.4, CAMP_BODY_RADIUS), false, '门列也不得走出 12 高');
  assert.equal(hall.walkable(4, 4, CAMP_BODY_RADIUS), false, 'hall 长凳是实体');
  // 每个室内地点都能建出同构空间，且门口同一扇门。
  for (const room of ['home', 'store', 'workshop', 'watch']) {
    const space = roomSpaceOf(w, room);
    assert.ok(space, `${room} 缺房间空间`);
    assert.equal(space.walkable(8, 11.5, CAMP_BODY_RADIUS), true, `${room} 门口可站`);
    assert.equal(space.walkable(0.5, 6, CAMP_BODY_RADIUS), false, `${room} 左墙`);
  }
  // 服务端/客户端同一份数据：roomStage 的家具规格来自 shared/room-layout.mjs。
  const full = roomStage('hall', roomPropsPx('hall', {}), hallFrontGeometry(), 16, 12, null);
  const surface = roomSurface({ room: 'hall', stage: full, bounds: full.walkBounds, door: ROOM_DOOR_WORLD });
  assert.equal(surface.walkable(4, 4, CAMP_BODY_RADIUS), false);
});

test('P2c-05 居民连续移动：按 space 路径逐段推进，到达才同步 loc/occupancy', () => {
  const sp = start(), w = sp.world;
  const id = 'a1';
  w.loc[id] = 'home';
  w.pos[id] = { x: 6, z: 9, space: 'room:home' };
  const loc = 'district-southwest';
  assert.ok(w.districts[loc]);
  startMove(w, id, loc);
  const row = w.survival.districtTravel[id];
  assert.ok(row);
  assert.ok(Array.isArray(row.path) && row.path.length > 0, '正式游戏必须有路径');
  assert.ok(Number.isFinite(row.length) && row.length > 0);
  assert.equal(row.arrive - w.t, Math.max(2, Math.ceil(row.length / unitsPerTick('walk')) + 1));
  const depart = posOf(w, id);
  assert.equal(depart.space, 'world', '出门即切到世界空间');
  const startT = w.t;
  const samples = [];
  let guard = 0;
  while (w.survival.districtTravel[id] && guard < 80) {
    w.t += 1;
    advanceTravels(w);
    guard += 1;
    samples.push({ t: w.t, pos: { ...posOf(w, id) }, loc: w.loc[id], index: w.survival.districtTravel[id]?.index ?? null });
  }
  assert.ok(guard < 80, '旅行必须在有限刻内到达');
  assert.equal(w.survival.districtTravel[id], undefined, '必须到达并清理旅行索引');
  assert.equal(w.loc[id], loc, '到达才同步地点');
  assert.ok((w.occupancy[loc] ?? []).includes(id), '到达才同步占用');
  assert.equal(posOf(w, id).space, 'world');
  // 逐刻位移不得超过同一 speedBudget 的 walk 档；到达刻等于 ceil(长度/预算)。
  let prev = depart, maxStep = 0;
  samples.forEach((s, i) => {
    maxStep = Math.max(maxStep, Math.hypot(s.pos.x - prev.x, s.pos.z - prev.z));
    prev = s.pos;
    // 到达前 loc 不得变；最后一个采样点就是到达刻，允许已同步。
    if (i < samples.length - 1) assert.notEqual(s.loc, loc, 'loc 不得在到达前改变');
  });
  assert.ok(maxStep <= unitsPerTick('walk') + 1e-6, `单刻位移 ${maxStep} 超过 22.5`);
  assert.equal(samples.length, row.arrive - startT, '到达刻必须等于路径刻数（ceil + 到点缓冲）');
  // 路径每个采样点都在 space 里可走（不穿墙）。
  const space = constructionSpace(w) ?? sceneSpace(w);
  const routeStart = row.start;
  assert.ok(space.walkable(routeStart[0], routeStart[1], 0), '路径起点可走');
  assert.ok(routeLength(row.path, routeStart) > 0);
  // 研究态：没有连续路径，仍是 12/刻锚点到达。
  const lab = start(13, { actTimeModel: false });
  const lw = lab.world;
  lw.loc.a1 = lw.loc.p1;
  startMove(lw, 'a1', Object.keys(lw.districts)[0]);
  assert.equal(lw.survival.districtTravel.a1.path, undefined);
});

test('P2c-06 玩家与居民同一 speedBudget：22.5/刻步行；冲刺 39.375/刻只在同一张表', () => {
  assert.equal(GAME_BASE_UNITS_PER_TICK, 22.5);
  assert.equal(unitsPerTick('walk'), 22.5);
  assert.equal(GAME_PLAYER_UNITS_PER_TICK, 39.375);
  assert.equal(unitsPerTick('sprint'), 39.375);
  const sp = start(), w = sp.world;
  const x = 200, z = 100;
  const reset = () => { w.survival.playerPos = { x, z, t: w.t }; w.survival.playerReachState = null; w.campPlayerRoom = null; w.pos.p1 = { x, z, space: 'world' }; };
  reset();
  assert.equal(playerReach(w, [x + 22.5, z], 'gather').ok, true);
  reset();
  assert.equal(playerReach(w, [x + 22.5 + .01, z], 'gather').code, 'TELEPORT');
  reset();
  assert.equal(playerReach(w, [x + 39.375, z], 'player_sync').ok, true);
  reset();
  assert.equal(playerReach(w, [x + 39.375 + .01, z], 'player_sync').code, 'TELEPORT');
});

test('P2c-07 穿墙/越界拒绝：室外实体、房间墙/家具、WILDS 外', () => {
  const sp = start(), w = sp.world;
  const space = constructionSpace(w);
  const solid = space.colliders.find((c) => c.w >= .6 && c.d >= .6);
  assert.ok(solid);
  w.campPlayerRoom = null;
  w.survival.playerPos = { x: solid.x + solid.w / 2 - 1, z: solid.z + solid.d / 2, t: w.t };
  w.survival.playerReachState = null;
  assert.equal(playerReach(w, [solid.x + solid.w / 2, solid.z + solid.d / 2], 'player_sync').code, 'OUT_OF_REACH');
  assert.equal(playerReach(w, [-300, -300], 'player_sync').code, 'OUT_OF_REACH');
  w.campPlayerRoom = 'hall';
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  w.survival.playerReachState = null;
  assert.equal(playerReach(w, [8, 12.6], 'player_sync').code, 'OUT_OF_REACH', '越出房间');
  assert.equal(playerReach(w, [0.4, 6], 'player_sync').code, 'OUT_OF_REACH', '房间墙');
});

test('P2c-08 A* 单入口：web/walk.astar 是唯一薄包装，核心只有 pixelPath；worldRoute 是同一核心的世界适配', () => {  assert.equal(joinedRoute, worldRoute, 'joinedRoute 只是 worldRoute 的兼容别名，不是第二套实现');
  const outsides = readFileSync(new URL('../shared/camp-outskirts.mjs', import.meta.url), 'utf8');
  assert.equal(/pixelPath\s*\(/.test(outsides), false, 'camp-outskirts 不得再含寻路实现');
  assert.equal(/function\s+joinedRoute/.test(outsides), false, 'camp-outskirts 不得再有 joinedRoute 实体');
  const walk = readFileSync(new URL('../web/walk.mjs', import.meta.url), 'utf8');
  assert.equal((walk.match(/export function astar/g) ?? []).length, 1);
  assert.match(walk, /pixelPath\(/);
  // 同一 tile 栅格：astar = pixelPath 转向点展开。
  const grid = { tw: 9, th: 7, walk: new Uint8Array(9 * 7).fill(1) };
  const route = worldRoute([1, 1], [5, 1], () => true, { margins: [4] });
  assert.deepEqual(route.at(-1), [5, 1]);
  assert.deepEqual(astar(grid, [1, 1], [1, 1]), []);
});

test('P2c-09 房间进出是 portal 迁移：进门切 room 空间，出门切回门外世界点', () => {
  const sp = start(), w = sp.world;
  const gate = campEntrance('hall', w.campLayout.sites.hall);
  const from = [gate.x + gate.w / 2, gate.z + gate.d / 2];
  w.survival.playerPos = { x: from[0], z: from[1], t: w.t };
  w.survival.playerReachState = null;
  w.pos.p1 = { x: from[0], z: from[1], space: 'world' };
  w.campPlayerRoom = null;
  const entered = survAct(sp, { kind: 'move', room: 'hall', entrance: true, from });
  assert.equal(entered.ok, true, JSON.stringify(entered));
  assert.equal(w.loc.p1, 'hall');
  assert.equal(w.campPlayerRoom, 'hall');
  assert.equal(w.pos.p1.space, 'room:hall');
  assert.equal(w.survival.playerPos.x, 8);
  assert.equal(w.survival.playerPos.z, 11.5);
  // 进门后的室内同步：同一个门口坐标应放行。
  assert.equal(playerReach(w, [8.1, 11.4], 'player_sync').ok, true);
  // 出屋：位置原子切到房门外世界点，campPlayerRoom 清空，下一次世界同步不再被判瞬移。
  const exited = survAct(sp, { kind: 'camp_exit' });
  assert.equal(exited.ok, true);
  assert.equal(w.campPlayerRoom, null);
  assert.equal(w.pos.p1.space, 'world');
  const door = roomDoorPoint(w, 'hall');
  assert.deepEqual([w.pos.p1.x, w.pos.p1.z], door);
  const step = playerReach(w, [door[0] + .5, door[1] + .5], 'player_sync');
  assert.equal(step.ok, true, JSON.stringify(step));
});

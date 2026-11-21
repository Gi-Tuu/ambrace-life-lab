// 2026-11-21 时间节奏 × 移动修复专项闸门（1:10 事故的回归钉）。
//
// 事故：位移按“单位/游戏分钟”换算，1:10 下 1 现实秒只走 0.0625 tile（整段慢 48×）；
// quickstart 固定按键 1200ms 只走 0.074（1.1.2 是 700ms→2.1）。
// 本文件钉住五件事：
//   01 位移按真实时间：1s=3 tile、冲刺 5.25；与 msPerGameMinute/刻长无关；
//   02 服务端 playerReach（有 simClock）：真实经过毫秒 × 速度 × 1.5 + 1 tile，超额度仍 TELEPORT；
//      同一世界刻内连续走 40+ tile 不得被旧 39.375/刻预算拉回；
//   03 居民旅行：到达时长由真实长度推导（200 单位 ≈ 67s，不是 36 分钟），逐分钟推进；
//   04 A/B 两世界同一时钟 ⇒ 到达时刻/轨迹逐位一致；60s = 10 游戏分不变；
//   05 源码闸门：位移路径不得再出现 tickMs 换算/每刻 cap。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createSurvPlay } from './survplay.mjs';
import { startMove, advanceTravels } from './body.mjs';
import { playerReach } from './survplay-camp.mjs';
import { constructionSpace } from './construction-access.mjs';
import { simMinuteNow, createSimClock } from './sim-clock.mjs';
import { campBridgeBounds } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import {
  WALK_UNITS_PER_REAL_SECOND, SPRINT_UNITS_PER_REAL_SECOND,
  GAME_MINUTES_PER_TICK, GAME_BASE_UNITS_PER_TICK, GAME_PLAYER_UNITS_PER_TICK,
  unitsForRealMs, unitsPerRealTick, unitsPerTick, reachAllowanceForRealMs,
} from './space.mjs';

const FORMAL = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
};
const formal = (seed, extra = {}) => createSurvPlay(seed, { ...FORMAL, mapSeed: seed, ...extra });

test('PACE-MOVE-01 位移按真实时间：1s=3 tile、冲刺 5.25；与游戏分钟/刻长无关', () => {
  assert.equal(WALK_UNITS_PER_REAL_SECOND, 3);
  assert.equal(SPRINT_UNITS_PER_REAL_SECOND, 5.25);
  // 60 帧 × 16.7ms：1 秒真实按键 = 3 tile（冲刺 5.25），不是 0.0625。
  let walk = 0, sprint = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60; i += 1) {
    walk += unitsForRealMs(dt * 1000, false);
    sprint += unitsForRealMs(dt * 1000, true);
  }
  assert.ok(Math.abs(walk - 3) < 1e-9, `1 秒步行应 3 tile（实测 ${walk}）`);
  assert.ok(Math.abs(sprint - 5.25) < 1e-9, `1 秒冲刺应 5.25 tile（实测 ${sprint}）`);
  // 5 秒按住：15 / 26.25 tile；这是客户端每帧步长的累计，与服务端刻长无关。
  assert.equal(unitsForRealMs(5000, false), 15);
  assert.equal(unitsForRealMs(5000, true), 26.25);
  // 1:10 的“游戏分钟”口径仍然成立：60s 真实 = 10 游戏分（时间闸门不回归）。
  let now = 0;
  const clock = createSimClock({ now: () => now });
  now = 60_000;
  assert.equal(clock.nowMinutes(), 10, '60 现实秒必须仍 = 10 游戏分');
  // 一刻真实位移预算：正式 6000ms/游戏分 ⇒ 1080/1890；旧 125ms 节奏下仍是真实秒换算。
  assert.equal(unitsPerRealTick('walk', 6000), 1080);
  assert.equal(unitsPerRealTick('sprint', 6000), 1890);
  assert.equal(unitsPerRealTick('walk', 125), 22.5);
  // 游戏分钟预算表只服务动作/旅行语义，没有被位移改写。
  assert.equal(GAME_BASE_UNITS_PER_TICK, 22.5);
  assert.equal(GAME_PLAYER_UNITS_PER_TICK, 39.375);
  assert.equal(unitsPerTick('walk'), 22.5);
  assert.equal(GAME_MINUTES_PER_TICK, 60);
});

test('PACE-MOVE-02 服务端真实毫秒额度：同刻连续走 40+ tile 不被旧预算拉回；超额度仍 TELEPORT', () => {
  let fakeNow = 1_000_000;
  const clock = createSimClock({ now: () => fakeNow, startMinutes: 0 });
  const sp = formal(13, { simTime: true, simClock: clock });
  const w = sp.world;
  const x = 200, z = 100; // 野外可走开阔地（与 p2-space P2-03 同点）
  w.survival.playerPos = { x, z, t: w.t };
  w.survival.playerReachState = { atMs: fakeNow };
  const tickStart = w.t;
  // 客户端每 2 tile 上报一次：0.7s 一次 ⇒ 21 次 = 42 tile，仍远小于一刻（360s）。
  let px = x;
  for (let i = 1; i <= 21; i += 1) {
    fakeNow += 700;
    px += 2;
    const r = playerReach(w, [px, z], 'player_sync');
    assert.equal(r.ok, true, `第 ${i} 次连续上报不得被拉回（code=${r.code}，位置 ${px}）`);
  }
  assert.equal(w.t, tickStart, '整段 14.7 秒仍在同一世界刻：旧实现 39.375/刻在 42 tile 处必判 TELEPORT');
  assert.ok(Math.abs(w.survival.playerPos.x - px) < 1e-9, '提交位置必须与最后一次上报一致');
  // 负控：同一刻内瞬移 5 tile（100ms 内）仍判 TELEPORT。
  fakeNow += 100;
  assert.equal(playerReach(w, [px + 5, z], 'player_sync').code, 'TELEPORT', '伪造远端坐标必须拒');
  // 非移动动作按步行速度（更慢）给额度：1s 后 6 tile 仍超 5.5 额度。
  fakeNow += 1000;
  assert.equal(playerReach(w, [px + 6, z], 'gather').code, 'TELEPORT', '动作位移同样按真实步行速度');
  // 额度公式本身（1.5× + 1 tile）钉死，便于审查余量。
  assert.equal(reachAllowanceForRealMs(1000, 'walk'), 5.5);
  assert.equal(reachAllowanceForRealMs(1000, 'sprint'), 8.875);
});

test('PACE-MOVE-03 居民旅行按真实步速：时长≈长度/3 秒，逐分钟推进（200 单位 ≈ 67s）', () => {
  const clock = createSimClock({ manual: true });
  clock.setGameMinutes(0);
  const sp = formal(13, { simTime: true, simClock: clock });
  const w = sp.world;
  const loc = Object.keys(w.districts)[0];
  w.loc.a1 = w.loc.p1;
  startMove(w, 'a1', loc);
  const row = w.survival.districtTravel.a1;
  assert.ok(row && Array.isArray(row.path) && row.path.length > 0, '正式连续世界必须有 space 路径');
  const realSeconds = row.length / WALK_UNITS_PER_REAL_SECOND;
  const expectedMinutes = realSeconds * 1000 / 6000;
  assert.ok(Math.abs((row.arriveMin - simMinuteNow(w)) - expectedMinutes) < 1e-9,
    `到达游戏分钟必须 = 真实步行时长（期望 ${expectedMinutes}，实测 ${row.arriveMin - simMinuteNow(w)}）`);
  // 兼容读法仍报“整刻”，但结算以 arriveMin 为准：一段路不再等 6 刻 = 36 现实分钟。
  const minutes = [];
  let guard = 0;
  while (w.survival.districtTravel.a1 && guard < 200) {
    clock.advanceMinutes(1);
    advanceTravels(w, { minutes: 1 });
    minutes.push(simMinuteNow(w));
    guard += 1;
  }
  assert.equal(w.survival.districtTravel.a1, undefined, '必须到达并清理旅行索引');
  const elapsedGameMin = minutes.at(-1);
  const elapsedRealSec = elapsedGameMin * 6;
  assert.ok(Math.abs(elapsedRealSec - realSeconds) <= 6.5,
    `真实耗时必须≈长度/3（期望 ${realSeconds.toFixed(1)}s，实测 ${elapsedRealSec}s，路径长 ${row.length.toFixed(1)}）`);
  assert.ok(elapsedRealSec < 60, `营地内一段路不得等几十现实分钟（实测 ${elapsedRealSec}s）`);
  // 200 单位 ≈ 67 秒的换算本身（不依赖具体营地路线）。
  assert.ok(Math.abs(200 / WALK_UNITS_PER_REAL_SECOND - 66.67) < 0.01);
});

test('PACE-MOVE-04 A/B 同一时钟：到达时刻/最终位置逐位一致；居民 10 秒位置明显变化', () => {
  const clockA = createSimClock({ manual: true });
  const clockB = createSimClock({ manual: true });
  clockA.setGameMinutes(0); clockB.setGameMinutes(0);
  const a = formal(13, { simTime: true, simClock: clockA });
  const b = formal(13, { simTime: true, simClock: clockB });
  for (const sp of [a, b]) {
    const w = sp.world;
    const loc = Object.keys(w.districts)[0];
    w.loc.a1 = w.loc.p1;
    startMove(w, 'a1', loc);
  }
  const rowA = a.world.survival.districtTravel.a1;
  const rowB = b.world.survival.districtTravel.a1;
  assert.equal(rowA.arriveMin, rowB.arriveMin, '同一时钟的两世界 arriveMin 必须逐位一致');
  assert.equal(rowA.length, rowB.length);
  const startPos = { ...a.world.pos.a1 };
  // 10 现实秒 = 1.67 游戏分：服务端居民每游戏分走 18 单位，10s≈30 单位 ⇒ 位置明显变化。
  clockA.advanceMinutes(2); clockB.advanceMinutes(2);
  advanceTravels(a.world, { minutes: 2 });
  advanceTravels(b.world, { minutes: 2 });
  const moved = Math.hypot(a.world.pos.a1.x - startPos.x, a.world.pos.a1.z - startPos.z);
  assert.ok(moved >= 24, `居民 12 现实秒应明显移动（实测 ${moved.toFixed(1)} 单位）`);
  assert.deepEqual(a.world.pos.a1, b.world.pos.a1, 'A/B 居民位置必须一致');
  // 走完：两边同一分钟到达、落在同一点。
  let guard = 0;
  while ((a.world.survival.districtTravel.a1 || b.world.survival.districtTravel.a1) && guard < 200) {
    clockA.advanceMinutes(1); clockB.advanceMinutes(1);
    advanceTravels(a.world, { minutes: 1 });
    advanceTravels(b.world, { minutes: 1 });
    guard += 1;
  }
  assert.equal(Boolean(a.world.survival.districtTravel.a1), Boolean(b.world.survival.districtTravel.a1));
  assert.deepEqual(a.world.pos.a1, b.world.pos.a1, 'A/B 到达位置必须一致');
});

test('PACE-MOVE-06 compare A/B：同一真实时钟下玩家上报两边一致，正常走不被 TELEPORT', () => {
  let now = 1_000_000;
  const clockA = createSimClock({ now: () => now, startMinutes: 0 });
  const clockB = createSimClock({ now: () => now, startMinutes: 0 });
  const a = formal(13, { simTime: true, simClock: clockA });
  const b = formal(13, { simTime: true, simClock: clockB });
  for (const sp of [a, b]) {
    sp.world.survival.playerPos = { x: 200, z: 100, t: sp.world.t };
    sp.world.survival.playerReachState = { atMs: now };
  }
  let x = 200;
  for (let i = 1; i <= 10; i += 1) {
    now += 700; x += 2;
    const ra = playerReach(a.world, [x, 100], 'player_sync');
    const rb = playerReach(b.world, [x, 100], 'player_sync');
    assert.equal(ra.ok, true, `A 第 ${i} 步被拒（${ra.code}）`);
    assert.equal(rb.ok, true, `B 第 ${i} 步被拒（${rb.code}）`);
    assert.deepEqual(a.world.survival.playerPos, b.world.survival.playerPos, `第 ${i} 步 A/B 位置必须一致`);
    assert.deepEqual(a.world.survival.playerReachState, b.world.survival.playerReachState,
      `第 ${i} 步 A/B 额度窗口必须一致`);
  }
  // 同一时刻、同一伪造远端跳变：两边都必须拒（A/B 不得因时钟/顺序分叉）。
  now += 100;
  assert.equal(playerReach(a.world, [x + 8, 100], 'player_sync').code, 'TELEPORT');
  assert.equal(playerReach(b.world, [x + 8, 100], 'player_sync').code, 'TELEPORT');
});

test('PACE-MOVE-07 门口/桥上：状态清空首报与桥面连续走都不被真实额度误杀', () => {
  let fakeNow = 2_000_000;
  const clock = createSimClock({ now: () => fakeNow, startMinutes: 0 });
  const sp = formal(13, { simTime: true, simClock: clock });
  const w = sp.world;
  const space = constructionSpace(w);
  assert.ok(space, '正式世界必须有 space');
  // 桥上：真实 700ms 走 1.5 tile（步行额度 4.15）应通过；目标点必须仍由同一 space 判可走。
  const { riverCenter, riverHalfWidth } = campTerrain(13, true, 2);
  const bridge = campBridgeBounds(w.campLayout.crossZ - 1, w.campLayout.crossZ + 1, riverCenter, riverHalfWidth);
  const bx = (bridge[0] + bridge[2]) / 2, bz = (bridge[1] + bridge[3]) / 2;
  assert.equal(space.walkable(bx, bz, CAMP_BODY_RADIUS), true, '桥心必须可站');
  assert.equal(space.walkable(bx + 1.5, bz, CAMP_BODY_RADIUS), true, '桥面 1.5 tile 处必须可站');
  w.campPlayerRoom = null;
  w.survival.playerPos = { x: bx, z: bz, t: w.t };
  w.survival.playerReachState = { atMs: fakeNow };
  fakeNow += 700;
  assert.equal(playerReach(w, [bx + 1.5, bz], 'player_sync').ok, true, '桥面连续走必须放行');
  // 门口（进门后服务端把 playerReachState 清空）：1s 地板吸收首个门口上报，不误判瞬移。
  w.campPlayerRoom = 'hall';
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  w.survival.playerReachState = null;
  assert.equal(playerReach(w, [8.4, 11.5], 'player_sync').ok, true, '进门后的首个位置上报必须放行');
  // 门口不是免检通道：同一时刻 100ms 内跑 5 tile 仍判 TELEPORT。
  fakeNow += 100;
  assert.equal(playerReach(w, [13.5, 11.5], 'player_sync').code, 'TELEPORT', '门口跑远仍须拒');
});

test('PACE-MOVE-05 源码闸门：位移路径不得再有 tickMs 换算/每刻 cap；游戏分钟语义不回归', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const camp = readFileSync(new URL('./survplay-camp.mjs', import.meta.url), 'utf8');
  const body = readFileSync(new URL('./body.mjs', import.meta.url), 'utf8');
  const space = readFileSync(new URL('./space.mjs', import.meta.url), 'utf8');
  const pace = readFileSync(new URL('./pace-1to10.test.mjs', import.meta.url), 'utf8');
  // 旧的 48× 入口必须消失：movementTickMs/playerStepCap/tripSpeed 的 tickMs 换算。
  assert.doesNotMatch(app, /\b(?:movementTickMs|playerStepCap)\s*\(/, 'app.js 不得再按刻算位移 cap');
  assert.doesNotMatch(app, /tripSpeed\s*=/, 'app.js 居民旅行视觉速度不得再除 tickMs');
  assert.doesNotMatch(app, /playerUnitsPerTick/, 'app.js 不得再用每刻预算当位移上限');
  assert.match(app, /function playerRealStep\(dt\)\s*\{\s*return unitsForRealMs\(dt \* 1000, keys\.has\('sprint'\)\);/, '玩家步长必须只由真实毫秒决定');
  // 服务端额度公式唯一来源。
  assert.match(camp, /reachAllowanceForRealMs\(elapsedMs/, 'playerReach 真实额度必须走 space.mjs 的同一函数');
  assert.doesNotMatch(camp, /SYNC_REAL_SLACK/, '余量常数不得在 survplay-camp 另写一份');
  // 居民旅行在连续世界按真实每刻预算推进。
  assert.match(body, /unitsPerRealTick\(kind, per\)/, 'advanceTravels 的连续世界预算必须按真实速度');
  assert.match(body, /arriveMin:\s*simMinuteNow\(world\)/, '旅行到达必须由真实时长换算的游戏分钟决定');
  // unitsForRealMs 签名不再收 tickMs（旧三参调用会静默变冲刺，必须删干净）。
  assert.doesNotMatch(space, /unitsForRealMs = \(ms, tickMs/, 'unitsForRealMs 不得再收 tickMs');
  // 1:10 的“60s=10 游戏分”专项闸门仍在（本文件不重复加载测试模块）。
  assert.match(pace, /PACE-02 现实 60s 推进 10 游戏分/, '1:10 专项闸门不得被删');
});

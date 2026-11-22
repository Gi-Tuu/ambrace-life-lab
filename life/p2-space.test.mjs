// P2 第一刀：服务端接入闸门（空间一致 / 速度预算 / 旧档连续 / 研究态不变 / fallback 开关）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurvPlay, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { startMove, RESIDENT_UNITS_PER_TICK, PLAYER_UNITS_PER_TICK } from './body.mjs';
import { GAME_RESIDENT_UNITS_PER_TICK } from './body.mjs';
import { playerReach } from './survplay-camp.mjs';
import { constructionSpace } from './construction-access.mjs';
import { legacyGroundQuery } from '../test-support/legacy-space-oracle.mjs';
import { campSite, campEntrance } from '../shared/camp-interaction.mjs';
import { campBridgeBounds } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { GAME_BASE_UNITS_PER_TICK, GAME_PLAYER_UNITS_PER_TICK, unitsForRealMs, travelTicks, unitsPerTick, reachAllowanceForRealMs } from './space.mjs';

const FORMAL = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
};
const start = () => createSurvPlay(13, FORMAL);
const copy = (sp) => loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 13, FORMAL);

test('P2-01 正式游戏视图预算 = 冲刺预算 39.375/刻；研究态仍是旧 10/刻', () => {
  const sp = start(), w = sp.world;
  assert.equal(w.survival.actTimeModel, true);
  assert.equal(survView(sp).playerUnitsPerTick, GAME_PLAYER_UNITS_PER_TICK);
  const lab = createSurvPlay(7);
  assert.equal(lab.world.survival.actTimeModel, undefined);
  assert.equal(survView(lab).playerUnitsPerTick, PLAYER_UNITS_PER_TICK);
});

test('P2b-02-SERVER-MOVE 正式游戏居民 startMove 接同一 speedBudget + space 路径；研究态仍 12/刻', () => {
  const sp = start(), w = sp.world;
  const loc = Object.keys(w.districts)[0];
  const from = w.loc.p1;
  const fromPt = campSite(from, w.campLayout);
  const toPt = w.districts[loc].at;
  w.loc.a1 = from;
  startMove(w, 'a1', loc);
  const trip = w.survival.districtTravel.a1;
  assert.ok(trip, '应产生 districtTravel');
  const dist = Math.hypot(toPt[0] - fromPt[0], toPt[1] - fromPt[1]);
  assert.ok(Array.isArray(trip.path) && trip.path.length > 0, '应有连续路径');
  assert.ok(trip.length >= dist - 1e-9, '路径不短于直线');
  assert.equal(trip.arrive - w.t, Math.max(2, Math.ceil(trip.length / unitsPerTick('walk')) + 1),
    '居民刻数必须由路径长度 × 同一 space 预算（walk 档）推导');
  assert.equal(GAME_RESIDENT_UNITS_PER_TICK, unitsPerTick('walk'), '居民预算来自同一函数');
  assert.equal(GAME_RESIDENT_UNITS_PER_TICK, 22.5, '步行预算 22.5/刻');
  assert.equal(unitsPerTick('sprint'), GAME_PLAYER_UNITS_PER_TICK, '玩家移动冲刺仍 39.375/刻');
  assert.equal(travelTicks(100, 'walk'), Math.ceil(100 / 22.5) + 1);
  // 研究态/旧时间模型不受影响：仍是 12/刻 + 无路径。
  const legacy = createSurvPlay(13, { ...FORMAL, actTimeModel: false });
  const lw = legacy.world;
  const lloc = Object.keys(lw.districts)[0];
  lw.loc.a1 = lw.loc.p1;
  startMove(lw, 'a1', lloc);
  const lfrom = campSite(lw.loc.p1, lw.campLayout), lto = lw.districts[lloc].at;
  const ldist = Math.hypot(lto[0] - lfrom[0], lto[1] - lfrom[1]);
  assert.equal(lw.survival.districtTravel.a1.arrive - lw.t,
    Math.max(2, Math.ceil(ldist / RESIDENT_UNITS_PER_TICK) + 1), '旧路径仍 12/刻');
  assert.equal(lw.survival.districtTravel.a1.path, undefined, '研究态没有连续路径');
  assert.equal(RESIDENT_UNITS_PER_TICK, 12, '旧常量保留给研究态');
  assert.equal(PLAYER_UNITS_PER_TICK, 10, '旧常量保留给非正式路径');
});

test('P2-03 正式游戏村外同预算：39.375/刻可走、再远判 TELEPORT（不再村外禁冲刺）', () => {
  const sp = start(), w = sp.world;
  const x = 200, z = 100; // WILDS 内、inCamp 外
  const reset = () => {
    w.survival.playerPos = { x, z, t: w.t };
    w.survival.playerReachState = null;
  };
  reset();
  assert.equal(playerReach(w, [x + GAME_PLAYER_UNITS_PER_TICK, z], 'player_sync').ok, true, '39.375/刻应通过');
  reset();
  assert.equal(playerReach(w, [x + GAME_PLAYER_UNITS_PER_TICK + 0.01, z], 'player_sync').code, 'TELEPORT', '超过同一预算必须拒');
});

test('P2-03b 非移动动作按基础步行预算 22.5/刻；冲刺预算只给 movement sync', () => {
  const sp = start(), w = sp.world;
  const x = 200, z = 100;
  const reset = () => {
    w.survival.playerPos = { x, z, t: w.t };
    w.survival.playerReachState = null;
  };
  reset();
  assert.equal(playerReach(w, [x + GAME_BASE_UNITS_PER_TICK, z], 'gather').ok, true);
  reset();
  assert.equal(playerReach(w, [x + GAME_BASE_UNITS_PER_TICK + 0.01, z], 'gather').code, 'TELEPORT');
});

test('P2-04 旧时间模型/研究态仍是村外 10/刻（不被新预算改写）', () => {
  const legacy = createSurvPlay(13, { mapSeed: 13, layoutVersion: 2, independentWorld: true, regionalWork: true, settlementLife: true });
  const w = legacy.world;
  assert.notEqual(w.survival.actTimeModel, true);
  const x = 200, z = 100;
  w.survival.playerPos = { x, z, t: w.t };
  w.survival.playerReachState = null;
  assert.equal(playerReach(w, [x + 20, z], 'player_sync').code, 'TELEPORT', '旧路径村外 20 单位仍拒');
});

test('P2-05 旧档读档位置连续：playerPos/loc/campPlayerRoom 原样恢复', () => {
  const sp = start(), w = sp.world;
  const site = campSite('hall', w.campLayout);
  const pos = { x: site[0] + 1.25, z: site[1] - .5, t: w.t };
  w.survival.playerPos = pos;
  w.campPlayerRoom = 'hall';
  const back = copy(sp);
  assert.deepEqual(back.world.survival.playerPos, pos);
  assert.equal(back.world.loc.p1, w.loc.p1);
  assert.equal(back.world.campPlayerRoom, 'hall');
});

test('P2-06 研究态 dumpSurv 逐位相同（space 不进入存档）', () => {
  const a = createSurvPlay(7), b = createSurvPlay(7);
  const da = JSON.stringify(dumpSurv(a)), db = JSON.stringify(dumpSurv(b));
  assert.equal(da, db);
  assert.equal(da.includes('"space"'), false);
  assert.equal(da.includes('GAME_'), false);
});

test('P2-07 服务端 construction space：岸带收紧、桥可走、桥面高度、门 portal', () => {
  const sp = start(), w = sp.world;
  const space = constructionSpace(w);
  assert.ok(space, '正式游戏应构建 space');
  const { riverCenter, riverHalfWidth } = campTerrain(w.mapSeed, true, w.layoutVersion);
  const z = 10;
  const bankX = (riverCenter(z * 16) + riverHalfWidth(z * 16) + 1.5) / 16;
  assert.equal(space.walkable(bankX, z, 0), false, '岸带不可走');
  assert.ok(Math.abs(bankX * 16 - riverCenter(z * 16)) > riverHalfWidth(z * 16), '旧公式在该点会放行');
  const bridge = campBridgeBounds(w.campLayout.crossZ - 1, w.campLayout.crossZ + 1, riverCenter, riverHalfWidth);
  const bx = (bridge[0] + bridge[2]) / 2, bz = (bridge[1] + bridge[3]) / 2;
  assert.equal(space.walkable(bx, bz, 0), true, '桥面可走');
  assert.ok(space.heightAt(bx, bz) >= .3, `桥面高度应来自 floors（实测 ${space.heightAt(bx, bz)}）`);
  const site = campSite('hall', w.campLayout);
  const door = campEntrance('hall', site);
  const portal = space.portalAt(door.x + door.w / 2, door.z + door.d / 2, 0);
  assert.equal(portal?.kind, 'door');
  assert.equal(portal?.room, 'hall');
});

test('P2-08/P4 fallback 开关已退役：正式模块没有开关，旧谓词只在 test-support oracle 里', () => {
  // 正式模块里不许再有开关函数/环境变量分支；退役谓词只保留在 test-support 测试 oracle。
  const formal = ['../life/construction-access.mjs', '../life/camp-play.mjs', '../web/app.js'];
  for (const rel of formal) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(/SPACE_V1|spaceQueriesEnabled|__SPACE_LEGACY__|space=legacy/.test(text), false, `${rel} 仍有旧空间开关`);
  }
  // 测试 oracle 保留旧谓词：它必须在“岸带”上与正式 space 给出不同答案（证明被替换的是真的旧实现）。
  const sp = start(), w = sp.world;
  const legacy = legacyGroundQuery({ mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, layout: w.campLayout, districts: w.districts });
  const { riverCenter, riverHalfWidth } = campTerrain(w.mapSeed, true, w.layoutVersion);
  const z = 10;
  const bankX = (riverCenter(z * 16) + riverHalfWidth(z * 16) + 1.5) / 16;
  assert.equal(legacy(bankX, z), true, '旧谓词只看河面，岸带放行');
  assert.equal(constructionSpace(w).walkable(bankX, z, 0), false, '正式 space 岸带不可走');
});

test('P2-09 客户端步长与服务端额度同源：真实速度（不再有 tickMs 隐藏上限）', () => {
  // 2026-11-21 位移修复：旧断言用 GAME_PLAYER_UNITS_PER_TICK*1000/tickMs*dt 作 cap，
  // 在 360000ms/刻下等出 0.109375 tile/s 的隐藏上限（正是 48× 事故）。现在客户端步长
  // 只由真实毫秒决定，服务端额度只由真实经过毫秒决定，两者同源、同量纲。
  assert.equal(unitsForRealMs(1000), 3);
  assert.equal(unitsForRealMs(1000, true), 5.25);
  for (const dt of [1 / 60, 0.05, 0.2]) {
    const normal = unitsForRealMs(dt * 1000, false);
    const sprint = unitsForRealMs(dt * 1000, true);
    assert.ok(Math.abs(normal - 3 * dt) < 1e-12, `步行步长 = 3×dt（实测 ${normal}）`);
    assert.ok(Math.abs(sprint - 5.25 * dt) < 1e-12, `冲刺步长 = 5.25×dt（实测 ${sprint}）`);
    // 服务端 1.5× 余量 + 1 tile：任意 dt 下同窗口额度都不小于客户端一步。
    assert.ok(reachAllowanceForRealMs(dt * 1000, 'walk') >= normal);
    assert.ok(reachAllowanceForRealMs(dt * 1000, 'sprint') >= sprint);
  }
  // 1 秒真实时间：额度 3×1.5+1=5.5（步行）/5.25×1.5+1=8.875（冲刺）。
  assert.equal(reachAllowanceForRealMs(1000, 'walk'), 5.5);
  assert.equal(reachAllowanceForRealMs(1000, 'sprint'), 8.875);
  // 5 秒累计仍按真实速度线性增长（没有第二条按刻换算的 cap）。
  assert.equal(unitsForRealMs(5000), 15);
  assert.equal(reachAllowanceForRealMs(5000, 'walk'), 23.5);
});


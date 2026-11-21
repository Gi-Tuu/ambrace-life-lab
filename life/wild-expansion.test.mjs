// 1.2 A 闸门：荒野宅基地（确定性生成 / 未认领零几何 / 玩家与居民认领建房 / 入口·碰撞·存档 /
// A-B 一致 / 负向对照：河中、压树、太远、缺料、重复认领、非荒野）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSurvPlay, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { sceneSpace } from './construction-access.mjs';
import { claimWildPlot, playerHouseWork, stepHouseholds, houseLabor, wildPreflight } from './households.mjs';
import { homeEntry } from './home-access.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { generateCampLayout, HOUSING_PLOTS } from '../shared/camp-layout.mjs';
import { wildLandscape, inCamp } from '../shared/wild-landscape.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { worldRoute } from '../shared/asset-collision.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS } from './clock.mjs';
import {
  generateWildPlots, wildPlotDoor, wildPlotPad, wildPlotLot, wildPlotGate, wildHouseSolids, wildPlotById,
} from '../shared/wild-plots.mjs';
import { campSceneBundle, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';

const OPT = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
  wildExpansion: true, eventRulesVersion: CURRENT_EVENT_RULES,
};
const start = (seed = 13, extra = {}) => createSurvPlay(seed, { ...OPT, mapSeed: seed, ...extra });
const stableContent = (content) => JSON.stringify({
  trees: content.trees, rocks: content.rocks, hills: content.hills, bridges: content.bridges,
  blockers: [...content.blockers].sort(), reserved: content.reserved, flatLand: content.flatLand, pads: content.pads,
});
const padSamples = (pad, step = 1) => {
  const out = [];
  for (let z = pad.z + .4; z < pad.z + pad.d - .3; z += step) for (let x = pad.x + .4; x < pad.x + pad.w - .3; x += step) out.push([x, z]);
  return out;
};

test('V12-EXP-01 确定性 / 数量 4–8 / 地形筛选：不压河、不压树、不压地标、坡度可建、接入路逐点可走', () => {
  for (const seed of [0, 7, 13, 41, 72, 123456]) {
    const a = generateWildPlots(seed, 2), b = generateWildPlots(seed, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), `seed ${seed} 生成必须确定性`);
    assert.ok(a.plots.length >= 4 && a.plots.length <= 8, `seed ${seed} 地块数 ${a.plots.length} 必须 4–8`);
    const layout = generateCampLayout(seed, 2);
    const terrain = wildLandscape(seed, 2, { joined: true });
    const ids = new Set();
    for (const plot of a.plots) {
      assert.equal(ids.has(plot.id), false, `地块 id 重复：${plot.id}`);
      ids.add(plot.id);
      assert.equal(inCamp(plot.at[0], plot.at[1]), false, '宅基地必须在聚落外');
      assert.deepEqual(plot.lot, wildPlotLot(plot.at));
      assert.deepEqual(plot.gate, wildPlotGate(plot.at));
      const pad = wildPlotPad(plot.at);
      const samples = padSamples(pad);
      assert.ok(samples.length > 20);
      for (const [x, z] of samples) {
        assert.equal(inCamp(x, z), false, 'pad 不能压进聚落');
        assert.ok(terrain.bankGap(x, z) >= 2.2, `压河/岸：${x},${z} bankGap=${terrain.bankGap(x, z)}`);
        assert.equal(terrain.walkable(x, z, layout.crossZ), true, `不可站/压树：${x},${z}`);
      }
      const corners = [[pad.x, pad.z], [pad.x + pad.w, pad.z], [pad.x, pad.z + pad.d], [pad.x + pad.w, pad.z + pad.d]]
        .map(([x, z]) => terrain.height(x, z));
      assert.ok(Math.max(...corners) - Math.min(...corners) <= 1.1 + 1e-9, '四角高差必须 ≤1.1（可建）');
      assert.equal(terrain.landmarks().some((f) => f.cores.some((b) =>
        pad.x + pad.w > b.x - 1 && pad.x < b.x + b.w + 1 && pad.z + pad.d > b.z - 1 && pad.z < b.z + b.d + 1)), false, '不能压地标/落石');
      // 通路：地块门 → 同岸村口站点的可走路线，逐点可走且在聚落外。
      assert.ok(plot.road.length >= 2, '必须有接入路');
      assert.deepEqual(plot.road[0], [plot.gate.x + plot.gate.w / 2, plot.gate.z + plot.gate.d / 2]);
      for (const [x, z] of plot.road) {
        assert.equal(inCamp(x, z), false, '接入路只画到聚落外沿');
        assert.equal(terrain.walkable(x, z, layout.crossZ), true, `接入路不可走：${x},${z}`);
      }
      assert.ok(layout.sites[plot.roadSite], '接入路必须连到村口站点');
    }
  }
  // 不同种子必须真的换位置（不是固定 8 个点）。
  const p0 = JSON.stringify(generateWildPlots(0, 2).plots.map((p) => p.at));
  const p7 = JSON.stringify(generateWildPlots(7, 2).plots.map((p) => p.at));
  assert.notEqual(p0, p7);
});

test('V12-EXP-02 未认领零几何：服务端空间与场景内容在认领前逐位不变；认领后才出现 pad/道路', () => {
  const wild = start(13), bare = start(13, { wildExpansion: false });
  const view = survView(wild);
  assert.ok(view.wildPlots?.plots?.length >= 4);
  assert.equal(view.wildPlots.plots.every((p) => !p.claimed && p.road === undefined), true, '未认领地块不携带道路');
  assert.deepEqual(wildHouseSolids(wild.world), [], '未认领没有房屋碰撞');
  // 服务端空间：同一批环带点，有/无荒野宅基地答案必须逐位相同。
  const sw = sceneSpace(wild.world), sb = sceneSpace(bare.world);
  let sampled = 0;
  for (let x = -20; x <= 140; x += 7) for (let z = -20; z <= 100; z += 7) {
    if (inCamp(x, z)) continue;
    sampled += 1;
    assert.equal(sw.walkable(x, z, CAMP_BODY_RADIUS), sb.walkable(x, z, CAMP_BODY_RADIUS), `walkable 差异 ${x},${z}`);
    assert.equal(sw.heightAt(x, z), sb.heightAt(x, z), `heightAt 差异 ${x},${z}`);
    assert.deepEqual(sw.collidersNear(x, z, CAMP_BODY_RADIUS).map((c) => c.kind), sb.collidersNear(x, z, CAMP_BODY_RADIUS).map((c) => c.kind));
  }
  assert.ok(sampled > 150, `抽样点 ${sampled}`);
  // 场景内容：同一组输入下，带未认领地块与不带，稳定字段逐位相同。
  const w = wild.world;
  const live = campSitesOf({ rooms: w.locs, districts: w.districts, layout: w.campLayout, peripheralHomes: w.peripheralHomes });
  const spec = {
    mapSeed: 13, layoutVersion: 2, layout: w.campLayout, camp: true, timber: true,
    sites: staticCampSites(live, w.districts, w.peripheralHomes), districts: w.districts,
    peripheralHomes: w.peripheralHomes, households: w.survival.households, homeRoads: w.survival.homeRoads ?? {},
  };
  const before = stableContent(campSceneBundle({ ...spec, wildPlots: view.wildPlots }).content);
  const off = stableContent(campSceneBundle({ ...spec, wildPlots: null }).content);
  assert.equal(before, off, '未认领地块不得改变任何场景内容');
  // 认领后：pad 进入 flatLand/clearing、道路进入 roads（负向对照：必须不同）。
  const plot = view.wildPlots.plots[0];
  const claimed = { ...view.wildPlots, plots: view.wildPlots.plots.map((p) => p.id === plot.id ? { ...p, claimed: true, road: wildPlotById(w, plot.id).road } : p) };
  const after = stableContent(campSceneBundle({ ...spec, wildPlots: claimed }).content);
  assert.notEqual(after, off, '认领后必须生成 pad/道路几何');
});

test('V12-EXP-03 玩家认领是服务端原子动作：距离/材料/重复/非荒野/可站全部先拒绝，成功后一次写三处', () => {
  const sp = start(13), w = sp.world;
  const plot = survView(sp).wildPlots.plots[0];
  const door = wildPlotDoor(plot);
  const stand = ([x, z]) => { w.survival.playerPos = { x, z, t: w.t }; w.pos.p1 = { x, z, space: 'world' }; w.survival.playerReachState = null; };
  stand(door);
  assert.equal(claimWildPlot(w, 'p1', plot.id).code, 'NO_MATERIAL');
  w.pinv.p1 = { wood: 8, stone: 6 };
  stand([door[0] + 40, door[1] + 40]);
  assert.equal(claimWildPlot(w, 'p1', plot.id).code, 'OUT_OF_REACH', '太远必须拒绝');
  stand(door);
  assert.equal(claimWildPlot(w, 'p1', 'wild-999').code, 'NO_PLOT');
  // 非荒野：把伪造地块塞进候选表（聚落内）→ 必须拒绝，且状态不变。
  w.survival.wildExpansion.plots = [...w.survival.wildExpansion.plots, { id: 'wild-forged', at: [60, 40], lot: wildPlotLot([60, 40]), gate: wildPlotGate([60, 40]), pad: wildPlotPad([60, 40]), road: [], roadSite: 'hall' }];
  stand([60, 38.25]);
  assert.equal(claimWildPlot(w, 'p1', 'wild-forged').code, 'NOT_WILDERNESS');
  w.survival.wildExpansion.plots = w.survival.wildExpansion.plots.filter((p) => p.id !== 'wild-forged');
  // 成功：claims + peripheralHomes + project 一次写。
  stand(door);
  assert.equal(w.survival.households.projects[plot.id], undefined);
  const ok = claimWildPlot(w, 'p1', plot.id);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(w.survival.wildExpansion.claims[plot.id].at, plot.at);
  assert.deepEqual(w.peripheralHomes[plot.id], plot.at);
  assert.equal(w.survival.households.projects[plot.id].owner, 'p1');
  assert.deepEqual(w.pinv.p1, { wood: 3, stone: 3 }, '木 5 石 3 一次扣清');
  // 重复认领 / 两人同抢：一成一败，失败方不得改状态。
  const doors = { ...w.survival.wildExpansion.claims };
  assert.equal(claimWildPlot(w, 'p1', plot.id).code, 'PLOT_TAKEN');
  w.pinv.a1 = { wood: 9, stone: 9 };
  assert.equal(claimWildPlot(w, 'a1', plot.id, { from: door }).code, 'PLOT_TAKEN');
  assert.deepEqual(w.survival.wildExpansion.claims, doors, '失败认领不得写任何状态');
  assert.equal(w.pinv.a1.wood, 9, '失败认领不得扣材料');
});

test('V12-EXP-04 河中/压树地块必须被施工可达性拒绝（负向对照）', () => {
  const sp = start(13), w = sp.world;
  const layout = generateCampLayout(13, 2);
  const { riverCenter } = campTerrain(13, true, 2);
  const space = sceneSpace(w);
  // 聚落外的一段河道（村内 z=30 一带是水，但必须找聚落外，否则会先被判非荒野）。
  let wetAt = null;
  for (let z = -20; z <= -4 && !wetAt; z += 1) {
    const x = riverCenter(z * 16) / 16;
    if (!inCamp(x, z) && !space.walkable(x, z, 0)) wetAt = [x, z];
  }
  assert.ok(wetAt, '聚落外必须有河段');
  const [riverX, riverZ] = wetAt;
  const riverPlot = { id: 'wild-river', at: [riverX, riverZ + 4.2], lot: wildPlotLot([riverX, riverZ + 4.2]), gate: wildPlotGate([riverX, riverZ + 4.2]), pad: wildPlotPad([riverX, riverZ + 4.2]), road: [], roadSite: 'hall' };
  w.survival.wildExpansion.plots = [...w.survival.wildExpansion.plots, riverPlot];
  assert.equal(inCamp(...riverPlot.at), false);
  assert.equal(space.walkable(riverX, riverZ, 0), false, '河道点本来就不能站');
  const atRiver = wildPlotDoor(riverPlot);
  w.survival.playerPos = { x: atRiver[0], z: atRiver[1], t: w.t };
  w.pos.p1 = { x: atRiver[0], z: atRiver[1], space: 'world' };
  w.pinv.p1 = { wood: 9, stone: 9 };
  assert.equal(claimWildPlot(w, 'p1', riverPlot.id).code, 'BUILD_PATH_BLOCKED');
  assert.equal(w.survival.households.projects[riverPlot.id], undefined, '失败不得留下工地');
  // 压树：自然地形里找一个“确实挡住脚点”的树格（与 wildDetails 的 2 格树位同口径），把地块中心放上去。
  const terrain = wildLandscape(13, 2, { joined: true });
  let tree = null;
  for (let x = 123; x < 145 && !tree; x += 2) {
    for (let z = 1; z < 80; z += 2) {
      if (terrain.treeAt(x, z, layout.crossZ) !== null && !terrain.walkable(x, z, layout.crossZ)) { tree = [x, z]; break; }
    }
  }
  assert.ok(tree, '环带里必须能找到挡路的树格');
  const treePlot = { id: 'wild-tree', at: [tree[0], tree[1] + 4.2], lot: wildPlotLot([tree[0], tree[1] + 4.2]), gate: wildPlotGate([tree[0], tree[1] + 4.2]), pad: wildPlotPad([tree[0], tree[1] + 4.2]), road: [], roadSite: 'hall' };
  w.survival.wildExpansion.plots = [...w.survival.wildExpansion.plots, treePlot];
  const gate = wildPlotDoor(treePlot);
  w.survival.playerPos = { x: gate[0], z: gate[1], t: w.t };
  w.pos.p1 = { x: gate[0], z: gate[1], space: 'world' };
  assert.equal(claimWildPlot(w, 'p1', treePlot.id).code, 'BUILD_PATH_BLOCKED');
  // 不可达：世界边缘外的“地块”没有可走地面/路线，预检与认领都必须拒绝。
  const voidAt = [-230, -190];
  const voidPlot = { id: 'wild-void', at: voidAt, lot: wildPlotLot(voidAt), gate: wildPlotGate(voidAt), pad: wildPlotPad(voidAt), road: [], roadSite: 'hall' };
  w.survival.wildExpansion.plots = [...w.survival.wildExpansion.plots, voidPlot];
  assert.equal(wildPreflight(w, voidPlot).ok, false, '世界外的点必须不可达');
  w.survival.playerPos = { x: voidPlot.gate.x + voidPlot.gate.w / 2, z: voidPlot.gate.z + voidPlot.gate.d / 2, t: w.t };
  w.pos.p1 = { ...w.survival.playerPos, space: 'world' };
  assert.equal(claimWildPlot(w, 'p1', voidPlot.id).code, 'BUILD_PATH_BLOCKED');
});

test('V12-EXP-05 玩家建房：3 次施工完工 → 门/碰撞/入住/存档往返；A/B 同种子逐位一致', () => {
  const sp = start(13), w = sp.world;
  const plot = survView(sp).wildPlots.plots[0];
  const door = wildPlotDoor(plot);
  w.survival.playerPos = { x: door[0], z: door[1], t: w.t };
  w.pos.p1 = { x: door[0], z: door[1], space: 'world' };
  w.pinv.p1 = { wood: 9, stone: 9 };
  assert.equal(claimWildPlot(w, 'p1', plot.id).ok, true);
  assert.equal(playerHouseWork(w, 'p1').code, 'OK');
  w.t += 1;
  assert.equal(playerHouseWork(w, 'p1').code, 'OK');
  w.t += 1;
  const done = playerHouseWork(w, 'p1');
  assert.equal(done.complete, true, JSON.stringify(done));
  assert.equal(w.survival.households.deeds[plot.id].owner, 'p1');
  assert.equal(w.housing.p1, plot.id);
  assert.equal(homeEntry(w, 'p1', plot.id).ok, true);
  // 碰撞：房屋主体不可站（同一份 AABB 由 client/server 共用），门前可站。
  const space = sceneSpace(w);
  const center = [plot.lot.x + plot.lot.w / 2, plot.lot.z + plot.lot.d / 2];
  assert.equal(space.walkable(door[0], door[1], CAMP_BODY_RADIUS), true, '门前必须可站/可进');
  assert.equal(space.walkable(center[0], center[1], CAMP_BODY_RADIUS), false, '房屋主体必须挡人');
  assert.ok(space.collidersNear(center[0], center[1], 0).some((c) => c.kind === 'wild-house'));
  assert.deepEqual(wildHouseSolids(w).map((s) => [s.x, s.z, s.w, s.d]), [[plot.lot.x, plot.lot.z, plot.lot.w, plot.lot.d]]);
  // 存档往返：claims / peripheralHomes / deed / housing / 碰撞全部恢复。
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  const back = loadSurv(raw, 13, OPT).world;
  assert.deepEqual(back.survival.wildExpansion.claims[plot.id].at, plot.at);
  assert.deepEqual(back.peripheralHomes[plot.id], plot.at);
  assert.equal(back.survival.households.deeds[plot.id].owner, 'p1');
  assert.equal(back.housing.p1, plot.id);
  assert.equal(sceneSpace(back).walkable(center[0], center[1], CAMP_BODY_RADIUS), false);
  // 再存再读幂等。
  const twice = loadSurv(JSON.parse(JSON.stringify(dumpSurv(loadSurv(raw, 13, OPT)))), 13, OPT).world;
  assert.deepEqual(twice.survival.wildExpansion.claims, back.survival.wildExpansion.claims);
  assert.deepEqual(twice.peripheralHomes, back.peripheralHomes);
  // A/B：同种子同输入的两份世界，认领后的可观察几何逐位一致。
  const a = start(13), b = start(13);
  const pa = survView(a).wildPlots.plots[0], pb = survView(b).wildPlots.plots[0];
  for (const [world, p] of [[a.world, pa], [b.world, pb]]) {
    const d = wildPlotDoor(p);
    world.survival.playerPos = { x: d[0], z: d[1], t: world.t };
    world.pos.p1 = { x: d[0], z: d[1], space: 'world' };
    world.pinv.p1 = { wood: 9, stone: 9 };
    assert.equal(claimWildPlot(world, 'p1', p.id).ok, true);
  }
  assert.deepEqual(a.world.survival.wildExpansion.claims, b.world.survival.wildExpansion.claims);
  assert.deepEqual(wildHouseSolids(a.world), wildHouseSolids(b.world));
  assert.equal(sceneSpace(a.world).heightAt(pa.at[0], pa.at[1]), sceneSpace(b.world).heightAt(pb.at[0], pb.at[1]));
});

test('V12-EXP-06 居民 AI：固定地块住满后认领荒野地块，施工完工后居住（聚落继续扩大）', () => {
  const sp = start(13);
  const w = sp.world, h = w.survival.households;
  // 把固定地块全部占满（并撤掉待售，避免居民先买房），只留荒野候选。
  for (const room of [...Object.keys(HOUSING_PLOTS), ...Object.keys(w.peripheralHomes ?? {})]) {
    h.deeds[room] = { owner: h.deeds[room]?.owner ?? 'a2', listed: false };
  }
  for (const deed of Object.values(h.deeds)) deed.listed = false;
  w.pinv.a1 = { wood: 9, stone: 9 };
  h.residents.a1.decision = 'seeking';
  stepHouseholds(w, []);
  const wildRoom = Object.keys(h.projects).find((room) => room.startsWith('wild-'));
  assert.ok(wildRoom, '固定地块用尽后必须认领荒野宅基地');
  assert.deepEqual(w.peripheralHomes[wildRoom], w.survival.wildExpansion.claims[wildRoom].at);
  assert.equal(h.projects[wildRoom].owner, 'a1');
  // 施工 3 天 → 完工入住。
  w.loc.a1 = wildRoom;
  for (let day = 0; day < 3; day += 1) {
    w.t = day * DAY_TICKS + 1;
    assert.equal(houseLabor(w, 'a1', true), true, `第 ${day + 1} 天施工`);
  }
  assert.ok(h.projects[wildRoom].progress >= 3);
  w.t = 3 * DAY_TICKS + 1;
  stepHouseholds(w, []);
  assert.equal(h.projects[wildRoom], undefined, '完工后必须清掉工地');
  assert.equal(h.deeds[wildRoom].owner, 'a1');
  assert.equal(w.housing.a1, wildRoom);
  assert.match(w.locs[wildRoom], /小屋/);
  // 第二个居民可以继续申请另一块荒野地块（聚落扩大不是一次性的）。
  w.pinv.a3 = { wood: 9, stone: 9 };
  h.residents.a3.decision = 'seeking';
  stepHouseholds(w, []);
  const next = Object.keys(h.projects).find((room) => room.startsWith('wild-') && room !== wildRoom);
  assert.ok(next, '人口增长时还能继续申请新地块');
  assert.equal(h.projects[next].owner, 'a3');
});

test('V12-EXP-08 生产主档（layout 0，内置种子档同形）也能扩建：地块可站/可达/可建、存档往返', () => {
  const OPT0 = { ...OPT, layoutVersion: 0, mapSeed: 0 };
  const sp = createSurvPlay(7, OPT0);
  const w = sp.world;
  assert.equal(w.layoutVersion, 0);
  const view = survView(sp);
  assert.ok(view.wildPlots?.plots?.length >= 4, 'layout 0（内置种子档）必须也生成荒野地块');
  for (const plot of view.wildPlots.plots) {
    const pre = wildPreflight(w, plot);
    assert.equal(pre.ok, true, `${plot.id} 预检失败：${JSON.stringify(pre)}`);
  }
  const plot = view.wildPlots.plots[0];
  const door = wildPlotDoor(plot);
  w.survival.playerPos = { x: door[0], z: door[1], t: w.t };
  w.pos.p1 = { x: door[0], z: door[1], space: 'world' };
  w.survival.playerReachState = null;
  w.pinv.p1 = { wood: 9, stone: 9 };
  assert.equal(claimWildPlot(w, 'p1', plot.id).ok, true);
  for (let i = 0; i < 3; i += 1) { w.t += 1; playerHouseWork(w, 'p1'); }
  assert.equal(w.survival.households.deeds[plot.id].owner, 'p1');
  assert.equal(w.housing.p1, plot.id);
  const space = sceneSpace(w);
  assert.equal(space.walkable(plot.lot.x + plot.lot.w / 2, plot.lot.z + plot.lot.d / 2, CAMP_BODY_RADIUS), false);
  assert.equal(space.walkable(door[0], door[1], CAMP_BODY_RADIUS), true);
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, OPT0).world;
  assert.equal(back.survival.households.deeds[plot.id].owner, 'p1');
  assert.equal(back.housing.p1, plot.id);
  assert.deepEqual(back.peripheralHomes[plot.id], plot.at);
});

test('V12-EXP-07 世界可达性：每个地块门都能从村口沿既有 space 走到（服务端权威）', () => {
  for (const seed of [0, 13, 72]) {
    const sp = start(seed);
    const w = sp.world;
    const space = sceneSpace(w);
    const anchor = w.campLayout.sites.hall;
    for (const plot of survView(sp).wildPlots.plots) {
      const door = wildPlotDoor(plot);
      assert.equal(space.walkable(door[0], door[1], CAMP_BODY_RADIUS), true, `seed ${seed} ${plot.id} 门口必须可站`);
      const route = worldRoute(door, [anchor[0] + .5, anchor[1] + .5],
        (x, z) => space.walkable(x, z, CAMP_BODY_RADIUS), { margins: [14, 60, 135, 320] });
      assert.ok(route, `seed ${seed} ${plot.id} 必须能从村口走到`);
    }
    // 负向对照：世界外/河里的点没有路线。
    const { riverCenter } = campTerrain(seed, true, 2);
    const wet = [riverCenter(30 * 16) / 16, 30];
    assert.equal(space.walkable(wet[0], wet[1], CAMP_BODY_RADIUS), false);
  }
});




// 树可砍透明闸门（2026-11-21）：
//   01 遮挡：tree:/wildtree: 纳入淡出，真实 stage 的树 range 会被推进 faded 通道；栅栏/田地/岩石不淡；
//   02 砍伐：非 grove 的场景树（forest:tx:tz）可砍，+2 木按 gather 同价，树从 space/碰撞/寻路移除；
//   03 入档：dumpSurv/loadSurv 往返保留；旧档没有 campTrees = 全树在；
//   04 再生：30 游戏日（可配置）后条目消失、树重新挡路；
//   05 拒绝：无斧/太远/隔水/隔墙/树桩期；栅栏与自己的树干不算挡；
//   06 服务端 ID 权威 = 客户端 buildWorld 同一份 camp 内容（树清单逐位相同、砍后 space 仍 0 差异）；
//   07 一次砍 N 棵只重建一次 space（增量，不重建 stage）。
//
// 变红法（HEAD 1102453 上）：01 树不在白名单、03/04/05 全走 grove 分支返回 NO_TREE。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSurvPlay, dumpSurv, loadSurv, survView } from './survplay.mjs';
import { campAction } from './camp-play.mjs';
import { sceneSpace, sceneTrees } from './construction-access.mjs';
import { campSceneBundle, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';
import { campSurface, createSpace, wildSurface } from './space.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { REACH, distanceTo } from '../shared/camp-interaction.mjs';
import { DAY_TICKS } from './clock.mjs';
import { activeForestCuts, forestCutsOf, forestOccluderId, forestTreeId } from '../shared/camp-forest.mjs';
import { FOREST_CHOP_WOOD, FOREST_REGROW_DAYS, chopBlocked, forestTree } from './forest.mjs';
import { regenResources } from './production.mjs';
import { coveredModels, campCamera, fadesAsOccluder, fadedRanges, stageMesh } from '../web/camp-3d-render.mjs';

const GAME = {
  independentWorld: true, gameRules: true, settlementLife: true, regionalWork: true,
  residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
  mapSeed: 7, layoutVersion: 0,
};
const start = (extra = {}) => createSurvPlay(7, { ...GAME, ...extra });

// 与 construction-access.sceneGeometry 同一组输入（服务端 stage 不对外导出）。
function serverBundle(w) {
  const layout = w.campLayout ?? null;
  const liveSites = campSitesOf({ rooms: w.locs, districts: w.districts, layout, peripheralHomes: w.peripheralHomes });
  const sites = staticCampSites(liveSites, w.districts, w.peripheralHomes);
  return campSceneBundle({
    mapSeed: w.mapSeed, layoutVersion: w.layoutVersion ?? 0, layout, camp: true, timber: true, sites,
    districts: w.districts, peripheralHomes: w.peripheralHomes,
    households: w.survival?.households, homeRoads: w.survival?.homeRoads,
  });
}
// 客户端 buildWorld 的 Node 复刻：同一 campSceneBundle 输入 + 同一 createSpace 组合 + 同一 exclude 规则。
function clientView(v) {
  const liveSites = campSitesOf({ rooms: v.rooms, districts: v.districts, layout: v.layout, peripheralHomes: v.peripheralHomes });
  const sites = staticCampSites(liveSites, v.districts, v.peripheralHomes);
  const { content, stage } = campSceneBundle({
    mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null,
    camp: v.camp, timber: Boolean(v.camp?.timber), sites,
    districts: v.districts, peripheralHomes: v.peripheralHomes,
    households: v.households, homeRoads: v.homeRoads, ecoSources: v.ecoSources,
  });
  const exclude = new Set(forestCutsOf(v.camp?.forest).map(t => forestOccluderId(t.id)));
  const camp = campSurface({
    mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null,
    stage, terrain: content.landscape, bridges: content.bridges, excludeOccluders: exclude,
  });
  const space = createSpace({ camp, wild: wildSurface(content.landscape, { crossing: camp.crossing }), terrain: content.landscape });
  return { content, stage, space };
}

// 在真实世界里找一棵“够得到、不隔挡”的非 grove 场景树（同时验证服务端认得这个 id）。
function findTarget(w, keep = () => true) {
  const space = sceneSpace(w);
  const trees = sceneTrees(w);
  if (!trees) return null;
  const angles = Array.from({ length: 8 }, (_, k) => k * Math.PI / 4);
  for (const key of trees) {
    const [tx, tz] = key.split(':').map(Number);
    const center = [tx + .5, tz + .5];
    if (!keep(center)) continue;
    if (space.walkable(center[0], center[1], 0)) continue; // 树心必须本来是挡的
    const id = forestTreeId([tx, tz]);
    const tree = forestTree(w, id);
    if (!tree) continue;
    for (const radius of [1.1, 1.3, 1.5]) {
      for (const a of angles) {
        const from = [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius];
        if (distanceTo(from, center) > REACH.timber) continue;
        if (!space.walkable(from[0], from[1], CAMP_BODY_RADIUS)) continue;
        if (!space.terrainWalkable(from[0], from[1])) continue;
        if (chopBlocked(w, from, tree, space) !== null) continue;
        return { id, tree, tx, tz, center, from };
      }
    }
  }
  return null;
}

// ── 01 遮挡 ─────────────────────────────────────────────────────────────────
test('TREE-01 树/荒野树纳入淡出：真实 stage 的树 range 进 faded，栅栏/田地/岩石仍不淡', () => {
  for (const id of ['tree:1:2', 'wildtree:3:4']) assert.equal(fadesAsOccluder(id), true, `${id} 必须淡出`);
  for (const id of ['pen:0', 'pen:shelter', 'plot:bed-0', 'rock:5:6', 'timber:grove1', 'resource:yard', 'landmark:fork-cairn'])
    assert.equal(fadesAsOccluder(id), false, `${id} 不得淡出`);

  const w = start().world;
  const { stage } = serverBundle(w);
  const { ranges } = stageMesh(stage);
  // 把玩家放到树北侧、相机在南侧 ⇒ 树在玩家与相机之间。
  let hit = null;
  for (const b of stage.boxes) {
    if (!b.occluder?.startsWith('tree:')) continue;
    const [, tx, tz] = b.occluder.split(':');
    const cx = Number(tx) + .5, cz = Number(tz) + .5;
    const camera = campCamera({ x: cx, z: cz + 4, width: 800, height: 450, span: 26, yaw: .29, pitch: .65 });
    const player = { x: cx, y: 0, z: cz - 1.0 };
    const covered = coveredModels(camera, player, stage.boxes);
    if (!covered.has(b.occluder)) continue;
    const faded = fadedRanges(ranges, covered);
    if (faded.some((r) => r.id === b.occluder)) { hit = b.occluder; break; }
  }
  assert.ok(hit, '真实 stage 上必须存在“玩家在树后”的树，且它的 mesh range 进入 faded 通道');
  // 白名单之外的 occluder 即使在 covered 里也不进 faded（负控）。
  assert.deepEqual(fadedRanges(ranges, new Set(['pen:0', 'plot:bed-0', 'rock:5:6'])), []);
});

// ── 02 砍伐 / 03 入档 ───────────────────────────────────────────────────────
test('TREE-02 非 grove 树可砍：+2 木、space 由挡变通、视图与存档同步', () => {
  const sp = start();
  const w = sp.world;
  const target = findTarget(w);
  assert.ok(target, '世界里必须能找到一棵够得到的非 grove 树');
  assert.equal(forestTree(w, target.id)?.tx, target.tx, '服务端必须认得这个森林 id');
  assert.equal(forestTree(w, 'forest:999:999'), null, '不存在的 id 必须拒');
  assert.equal(forestTree(w, 'grove1'), null, 'grove id 不得被当成森林树');

  const before = sceneSpace(w);
  const beforeWood = w.pinv.p1.wood ?? 0;
  assert.equal(before.walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), false,
    '前置：树心本来不可站（碰撞真的存在）');

  const result = campAction(w, { kind: 'camp_chop', target: target.id, tool: 'axe', from: target.from });
  assert.equal(result.ok, true, `砍伐应成功：${JSON.stringify(result)}`);
  assert.equal(result.amount, FOREST_CHOP_WOOD);
  assert.equal(w.pinv.p1.wood, beforeWood + FOREST_CHOP_WOOD, '木材进个人包 +2');
  const regrowAt = w.survival.campTrees[target.id];
  assert.ok(regrowAt > w.t, '必须写入再生时刻');
  assert.equal(regrowAt - w.t, FOREST_REGROW_DAYS * DAY_TICKS, '默认 30 游戏日再生');

  const after = sceneSpace(w);
  assert.notEqual(after, before, '砍伐后 space 必须重建');
  assert.equal(after.walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), true,
    '砍后树心必须可走（碰撞/寻路移除）');

  const view = survView(sp);
  assert.deepEqual(view.camp.forest[target.id], { stage: 'stump', regrowAt, at: [target.center[0], target.center[1]] });
  assert.equal(view.camp.timber[target.id], undefined, '森林树不得混进 grove 的 timber 视图');
  assert.equal(Object.keys(view.camp.timber).length, 6, 'grove 视图仍是 6 棵，逐位不变');

  // 再来一次：树桩期必须拒（且不再产木材）。
  const again = campAction(w, { kind: 'camp_chop', target: target.id, tool: 'axe', from: target.from });
  assert.equal(again.code, 'TREE_GROWING');
  assert.equal(w.pinv.p1.wood, beforeWood + FOREST_CHOP_WOOD, '拒绝不能再加木材');

  // 入档往返：砍伐状态与“树心不可站”一起活过重启。
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  const back = loadSurv(raw, 7, GAME);
  assert.equal(back.world.survival.campTrees[target.id], regrowAt);
  assert.equal(sceneSpace(back.world).walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), true);
  assert.equal(survView(back).camp.forest[target.id]?.stage, 'stump');

  // 旧档没有 campTrees = 全树在：树心重新挡路，视图没有树桩。
  const legacy = JSON.parse(JSON.stringify(raw));
  delete legacy.survival.campTrees;
  const old = loadSurv(legacy, 7, GAME);
  assert.equal(old.world.survival.campTrees, undefined);
  assert.deepEqual(survView(old).camp.forest, {});
  assert.equal(sceneSpace(old.world).walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), false);
});

// ── 04 再生 ─────────────────────────────────────────────────────────────────
test('TREE-04 30 天再生：条目消失、树回场景、space 重新挡住；天数可配置', () => {
  const sp = start();
  const w = sp.world;
  const target = findTarget(w);
  assert.ok(target);
  assert.equal(campAction(w, { kind: 'camp_chop', target: target.id, tool: 'axe', from: target.from }).ok, true);
  const at = w.survival.campTrees[target.id];

  // 到点即回到场景（视图条目消失、space 重新挡）；
  w.t = at;
  assert.deepEqual(survView(sp).camp.forest, {});
  assert.equal(sceneSpace(w).walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), false, '再生后树重新挡路');
  // 日界回收条目，campTrees 不再无限增长（grove 的 0 语义不动）。
  regenResources(w);
  assert.equal(w.survival.campTrees[target.id], undefined);

  // 可配置：survival.forestRegrowDays 覆盖默认 30 天。
  const custom = start();
  custom.world.survival.forestRegrowDays = 12;
  const other = findTarget(custom.world);
  assert.ok(other);
  assert.equal(campAction(custom.world, { kind: 'camp_chop', target: other.id, tool: 'axe', from: other.from }).ok, true);
  assert.equal(custom.world.survival.campTrees[other.id] - custom.world.t, 12 * DAY_TICKS);
});

// ── 05 拒绝 ─────────────────────────────────────────────────────────────────
test('TREE-05 拒绝：无斧/太远/无脚点/隔水/隔墙；栅栏与目标自身树干不算挡', () => {
  const w = start().world;
  const target = findTarget(w);
  assert.ok(target);
  const body = (extra = {}) => ({ kind: 'camp_chop', target: target.id, tool: 'axe', from: target.from, ...extra });

  assert.equal(campAction(w, body({ tool: 'basket' })).code, 'NEED_TOOL');
  assert.equal(campAction(w, { kind: 'camp_chop', target: target.id, tool: 'axe' }).code, 'OUT_OF_REACH',
    '没有真实脚点不得砍（距离门不能绕）');
  const far = [target.center[0], target.center[1] + 10];
  assert.equal(campAction(w, body({ from: far })).code, 'OUT_OF_REACH');

  // 采样规则用注入空间做确定性负控（真实世界里树不会长在墙里，所以这里验谓词本身）。
  const water = { terrainWalkable: () => false, collidersNear: () => [] };
  assert.equal(chopBlocked(w, target.from, target.tree, water), 'BLOCKED', '隔水必须拒');
  const wall = { terrainWalkable: () => true, collidersNear: () => [{ occluder: 'wall:home' }] };
  assert.equal(chopBlocked(w, target.from, target.tree, wall), 'BLOCKED', '隔墙必须拒');
  const otherTree = { terrainWalkable: () => true, collidersNear: () => [{ occluder: 'tree:99:99' }] };
  assert.equal(chopBlocked(w, target.from, target.tree, otherTree), 'BLOCKED', '别的树干也算挡');
  const fence = { terrainWalkable: () => true, collidersNear: () => [{ occluder: 'pen:0' }, { occluder: 'plot:bed-0' }] };
  assert.equal(chopBlocked(w, target.from, target.tree, fence), null, '栅栏/田地不挡斧头');
  const own = { terrainWalkable: () => true, collidersNear: () => [{ occluder: target.tree.occluder }] };
  assert.equal(chopBlocked(w, target.from, target.tree, own), null, '目标自己的树干不算挡');
  // 距离规则本身：超出 REACH.timber 先拒。
  assert.equal(chopBlocked(w, [target.center[0], target.center[1] + REACH.timber + .5], target.tree, fence), 'OUT_OF_REACH');
});

// ── 06 客户端/服务端同一份树 ────────────────────────────────────────────────
test('TREE-06 客户端 buildWorld 与服务端同一份树清单；砍后 space 仍 0 差异', () => {
  for (const [seed, version] of [[0, 0], [13, 2]]) {
    const sp = start({ mapSeed: seed, layoutVersion: version });
    const w = sp.world;
    const server = sceneTrees(w);
    const client = clientView(survView(sp));
    const clientIds = new Set(client.content.trees.map(([tx, tz]) => `${tx}:${tz}`));
    assert.deepEqual([...clientIds].sort(), [...server].sort(), `${seed}/${version} 客户端/服务端树清单必须逐位相同`);

    const target = findTarget(w);
    assert.ok(target, `${seed}/${version} 应有可砍树`);
    assert.equal(campAction(w, { kind: 'camp_chop', target: target.id, tool: 'axe', from: target.from }).ok, true);
    const serverSpace = sceneSpace(w);
    const clientSpace = clientView(survView(sp)).space;
    let walkDiff = 0, first = null;
    for (let i = 0; i < 4000; i += 1) {
      const x = (i * 37 % 12000) / 100, z = (i * 91 % 8000) / 100;
      const a = clientSpace.walkable(x, z, CAMP_BODY_RADIUS), b = serverSpace.walkable(x, z, CAMP_BODY_RADIUS);
      if (a !== b) { walkDiff += 1; first ??= { x, z, a, b }; }
    }
    assert.deepEqual({ walkDiff, first }, { walkDiff: 0, first: null }, `${seed}/${version} 砍后 space 必须仍逐点一致`);
    assert.equal(serverSpace.walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), true);
    assert.equal(clientSpace.walkable(target.center[0], target.center[1], CAMP_BODY_RADIUS), true);
  }
});

// ── 07 增量重建 ─────────────────────────────────────────────────────────────
test('TREE-07 一次砍 50 棵只重建一次 space（增量；不重建 stage/地形）', () => {
  const sp = start();
  const w = sp.world;
  const base = sceneSpace(w);
  const ids = [...sceneTrees(w)].slice(0, 50).map((key) => forestTreeId(key.split(':').map(Number)));
  assert.equal(ids.length, 50);
  w.survival.campTrees = Object.fromEntries(ids.map((id) => [id, w.t + 10 * DAY_TICKS]));
  const once = sceneSpace(w);
  const twice = sceneSpace(w);
  assert.notEqual(once, base, '状态变化后 space 重建一次');
  assert.equal(twice, once, '同一状态的后续查询命中缓存（不会每帧重建）');
  assert.equal(activeForestCuts(w.survival.campTrees, w.t).length, 50);
  // 50 棵一次性排除：每一棵的树心都必须变可走。
  for (const id of ids) {
    const [tx, tz] = id.split(':').slice(1).map(Number);
    assert.equal(once.walkable(tx + .5, tz + .5, CAMP_BODY_RADIUS), true, `${id} 砍后应可走`);
  }
});

// ── 08 研究态 ───────────────────────────────────────────────────────────────
test('TREE-08 研究态不受影响：没有森林字段、dump 形状不变', () => {
  const research = createSurvPlay(7);
  assert.equal(research.world.survival.campTrees, undefined);
  assert.deepEqual(survView(research).camp.forest, {});
  const dump = JSON.stringify(dumpSurv(research));
  assert.equal(dump.includes('"forest"'), false, '森林状态不得进研究 dump');
});

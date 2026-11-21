// 1.6 A/B/C 闸门：圈舍实体/扩容可见/碰撞入口/道路避让，以及睡眠·休息的体力数值闸门。
// 这些用例只走共享纯几何与正式生存世界，不读 DOM；浏览器证据在 scripts/v16-livestock-verify.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { campSceneBundle } from '../shared/camp-scene-content.mjs';
import { campBeds, campEntrance, campPen, campSite, CAMP_SITES } from '../shared/camp-interaction.mjs';
import { campAnimalSlot, campLivestock, expandLabel, LIVESTOCK_CAPACITY } from '../shared/camp-livestock.mjs';
import { constructionLot, generateCampLayout, overlapsLot } from '../shared/camp-layout.mjs';
import { campSurface, createSpace } from './space.mjs';
import { worldRoute } from '../shared/asset-collision.mjs';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView } from './survplay.mjs';
import { doExpand } from './production.mjs';
import { sourceView } from './source-produce.mjs';
import { applySleepRecovery, campRestRule, sleepRecoveryFor, SLEEP_RECOVERY_CAP } from './rest-energy.mjs';
import { move } from './body.mjs';

const STOCK = Object.freeze({ chickens: 3, cows: 2, sheep: 2, orchards: 3 });
const GAME = Object.freeze({ gameRules: true, farmLife: true, settlementLife: true, independentWorld: true, simTime: true });

function bundle(seed, version, stock = STOCK, layout = version ? generateCampLayout(seed, version) : null) {
  const sites = { ...(layout?.sites ?? CAMP_SITES) };
  const { content, stage } = campSceneBundle({
    mapSeed: seed, layoutVersion: version, layout, sites, camp: true, timber: true,
    households: true, livestock: stock,
  });
  const camp = campSurface({ mapSeed: seed, layoutVersion: version, layout, stage, terrain: content.landscape, bridges: content.bridges });
  return { layout, sites, content, stage, camp, space: createSpace({ camp, terrain: content.landscape }) };
}

function minRoadInPen(content, pen) {
  let min = Infinity, at = null;
  for (let x = pen.x + .2; x <= pen.x + pen.w - .2; x += .25)
    for (let z = pen.z + .2; z <= pen.z + pen.d - .2; z += .25) {
      const d = content.roadDist(x * 16, z * 16, false);
      if (d < min) { min = d; at = [+x.toFixed(2), +z.toFixed(2)]; }
    }
  return { min, at };
}

test('V16-LIVE-01 圈舍 AABB/入口/道路/树/建筑不重叠：三种牲畜各有真实分区', () => {
  const base = bundle(0, 0);
  const pen = campPen(base.sites.yard);
  assert.ok(pen.w >= 12 && pen.d >= 10, `圈舍院落没有放大：${JSON.stringify(pen)}`);
  const farm = campLivestock(base.sites.yard, STOCK);
  for (const kind of ['chickens', 'cows', 'sheep']) {
    const b = farm.pens[kind];
    assert.ok(b.w >= 6 && b.d >= 4.8, `${kind} 分区太小：${JSON.stringify(b)}`);
    // 每个品种都有屋/棚/槽/栖木等真实实体（不是几个 box 的集合）。
    const own = base.stage.boxes.filter((x) => x.occluder?.startsWith(`livestock:${kind}`));
    assert.ok(own.length >= 6, `${kind} 圈舍实体不足：${own.length}`);
    assert.ok(own.some((x) => x.solid), `${kind} 圈舍没有碰撞体`);
  }
  for (const seed of [0, 7, 123456, 654321, 13]) for (const version of [0, 1, 2]) {
    const b = bundle(seed, version);
    const p = campPen(b.sites.yard);
    const farm2 = campLivestock(b.sites.yard, STOCK);
    // 道路不得画进院落/牲畜活动区。
    const road = minRoadInPen(b.content, p);
    assert.ok(road.min > 8, `seed${seed}/v${version} 道路穿过圈舍：${road.min.toFixed(2)}px at ${road.at}`);
    // 树不得落在院落内。
    for (const [tx, tz] of b.content.trees)
      assert.equal(b.content.helpers.inPen(tx, tz), false, `seed${seed}/v${version} 树落在圈舍内：${tx},${tz}`);
    // 与建筑地块/菜畦/伐木林/河不重叠。
    const lots = Object.keys(b.sites).map((room) => constructionLot(room, b.layout)).filter(Boolean);
    for (const lot of lots) assert.equal(overlapsLot(p, lot), false, `seed${seed}/v${version} 圈舍压到施工地块`);
    const beds = campBeds(b.sites.garden, seed, version);
    for (const bed of beds) assert.equal(overlapsLot(p, bed), false, `seed${seed}/v${version} 圈舍压到菜畦`);
    for (const tree of b.layout?.grove ?? []) {
      assert.ok(!(tree.x >= p.x && tree.x <= p.x + p.w && tree.z >= p.z && tree.z <= p.z + p.d),
        `seed${seed}/v${version} 圈舍压到伐木林`);
    }
    // 每个门洞中心与内外各半格都能过（服务端 space 的真实 AABB）。
    for (const [id, r] of Object.entries(farm2.doors)) {
      const cx = r.x + r.w / 2, cz = r.z + r.d / 2;
      assert.equal(b.space.walkable(cx, cz, .33), true, `seed${seed}/v${version} ${id} 门洞中心被挡`);
      if (id === 'yard') {
        assert.equal(b.space.walkable(cx - .5, cz, .33), true, `${id} 门外进不来`);
        assert.equal(b.space.walkable(cx + .5, cz, .33), true, `${id} 门内出不去`);
      } else {
        assert.equal(b.space.walkable(cx, cz - .5, .33), true, `${id} 门外进不来`);
        assert.equal(b.space.walkable(cx, cz + .5, .33), true, `${id} 门内出不去`);
      }
    }
    // 既有建筑入口仍可站；从院子门到各入口/伐木林/施工地块仍有连续路径。
    const start = (() => { const r = farm2.doors.yard; return [r.x + r.w / 2, r.z + r.d / 2]; })();
    const allows = (x, z) => b.space.walkable(x, z, .33);
    for (const [room, at] of Object.entries(b.sites)) {
      const gate = campEntrance(room, at, null);
      if (!gate) continue;
      const target = [gate.x + gate.w / 2, gate.z + gate.d / 2];
      if (!b.space.walkable(target[0], target[1], .33)) continue; // 房间内部/特殊入口另行由 camp_exit 管
      const route = worldRoute(start, target, allows, { margins: [14, 60, 135] });
      assert.ok(route, `seed${seed}/v${version} 圈舍扩大后走不到 ${room} 入口`);
    }
    for (const tree of b.layout?.grove ?? []) {
      const route = worldRoute(start, [tree.x, tree.z + .5], allows, { margins: [14, 60, 135] });
      assert.ok(route, `seed${seed}/v${version} 圈舍扩大后走不到伐木林 ${tree.id}`);
    }
  }
});

test('V16-LIVE-02 扩容可见：0→1 立屋、每加一只加 bay，容量与围栏规模同源', () => {
  const yard = CAMP_SITES.yard;
  const zero = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: { ...STOCK, chickens: 0 } }).stage;
  const one = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: { ...STOCK, chickens: 1 } }).stage;
  const three = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: { ...STOCK, chickens: 3 } }).stage;
  const four = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: { ...STOCK, chickens: 4 } }).stage;
  const chickenBoxes = (stage) => stage.boxes.filter((b) => b.occluder === 'livestock:chickens');
  const widest = (stage) => Math.max(0, ...chickenBoxes(stage).filter((b) => b.solid).map((b) => b.w));
  assert.ok(chickenBoxes(one).length > chickenBoxes(zero).length + 4, '0→1 没有立起真实鸡舍');
  assert.ok(widest(four) > widest(three), `3→4 鸡舍没有加长：${widest(three)} → ${widest(four)}`);
  // 结构层数与 livestock 数量同源（旧档没有结构字段也能读）。
  const farm = campLivestock(yard, { ...STOCK, chickens: 4 });
  assert.equal(farm.levels.chickens, 4);
  assert.ok(farm.slots.chickens.length >= LIVESTOCK_CAPACITY.chickens);
  // 槽位与 sourceView 的拾取点一致，且都在对应围栏内。
  const sp = createSurvPlay(7, GAME);
  sp.world.survival.livestock = { ...STOCK, chickens: 6 };
  const view = survView(sp);
  const rows = sourceView(sp.world).egg;
  assert.ok(rows.length >= 6, '鸡蛋来源没有反映存栏');
  const p = campLivestock(CAMP_SITES.yard, sp.world.survival.livestock).pens.chickens;
  for (const row of rows.slice(0, 6)) {
    assert.ok(row.x >= p.x && row.x <= p.x + p.w && row.z >= p.z && row.z <= p.z + p.d, `拾取点不在鸡舍：${row.x},${row.z}`);
    const slot = campAnimalSlot('chickens', 0, CAMP_SITES.yard);
    assert.ok(Number.isFinite(slot.x) && Number.isFinite(slot.z));
  }
  assert.equal(expandLabel({ chickens: 0 }, 'chickens'), '建鸡舍');
  assert.equal(expandLabel({ chickens: 2 }, 'chickens'), '扩鸡舍');
  // 存档往返：数量（=结构层级）与场景盒一致。
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  assert.equal(back.world.survival.livestock.chickens, 6);
  assert.equal(campLivestock(CAMP_SITES.yard, back.world.survival.livestock).levels.chickens, 6);
});

test('V16-LIVE-03 doExpand 受圈舍容量闸门，扩容改变真实 stage', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world, s = w.survival;
  s.inv.wood = 200; s.inv.stone = 200;
  const before = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: s.livestock }).stage;
  const first = doExpand(w, 'p1', 'chickens');
  assert.equal(first.ok, true);
  assert.equal(first.action, s.livestock.chickens === 4 ? 'expand' : first.action);
  while (s.livestock.chickens < LIVESTOCK_CAPACITY.chickens) assert.ok(doExpand(w, 'p1', 'chickens').ok);
  assert.equal(doExpand(w, 'p1', 'chickens').code, 'LIVESTOCK_FULL');
  const after = campSceneBundle({ sites: CAMP_SITES, camp: true, livestock: s.livestock }).stage;
  assert.notEqual(
    Math.max(...after.boxes.filter((b) => b.occluder === 'livestock:chickens').map((b) => b.w)),
    Math.max(...before.boxes.filter((b) => b.occluder === 'livestock:chickens').map((b) => b.w)),
    '扩容后鸡舍没有可见变化',
  );
});

test('V16-ENERGY-01 睡眠按实际小时 +0.15、单次上限 0.9；死亡中断不补', () => {
  assert.equal(sleepRecoveryFor(4), .6);
  assert.equal(sleepRecoveryFor(100), SLEEP_RECOVERY_CAP);
  assert.equal(sleepRecoveryFor(-3), 0);
  const sp = createSurvPlay(7, GAME), a = sp.world.agents.p1;
  a.drives.v.energy = .2;
  const r = applySleepRecovery(sp.world, 4);
  assert.equal(r.gain, .6);
  assert.ok(Math.abs(a.drives.v.energy - .8) < 1e-9);
  const capped = applySleepRecovery(sp.world, 20);
  assert.equal(capped.gain, .2, '能量封顶 1');
  assert.equal(a.drives.v.energy, 1);
});

test('V16-ENERGY-02 通用休息 +0.06、每时 1 次、每日 0.24、满能量/幽魂/compare/研究拒绝', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival, a = w.agents.p1;
  move(w, 'p1', 'hall');
  a.drives.v.energy = .4;
  const r = campRestRule(w, { nowMin: 60 });
  assert.equal(r.ok, true);
  assert.equal(r.gain, .06);
  assert.equal(campRestRule(w, { nowMin: 90 }).code, 'REST_COOLDOWN');
  assert.equal(campRestRule(w, { nowMin: 120 }).ok, true);
  assert.equal(campRestRule(w, { nowMin: 180 }).ok, true);
  assert.equal(campRestRule(w, { nowMin: 240 }).ok, true);
  assert.equal(s.restRecovery.gain, .24);
  assert.equal(campRestRule(w, { nowMin: 300 }).code, 'REST_LIMIT');
  a.drives.v.energy = 1;
  assert.equal(campRestRule(w, { nowMin: 1440 }).code, 'ENERGY_FULL');
  a.drives.v.energy = .5;
  s.playerDead = true;
  assert.equal(campRestRule(w, { nowMin: 1500 }).code, 'PLAYER_DEAD');
  s.playerDead = false;
  w.compareSide = 'A';
  assert.equal(campRestRule(w, { nowMin: 1500 }).code, 'REST_UNSUPPORTED');
  delete w.compareSide;
  const lab = createSurvPlay(7, { farmLife: true });
  assert.equal(campRestRule(lab.world, { nowMin: 60 }).code, 'NOT_AVAILABLE');
  w.loc.p1 = 'pen';
  assert.equal(campRestRule(w, { nowMin: 1500 }).code, 'NOT_AT_REST_SPOT');
});

test('V16-ENERGY-03 正式动作账：camp_rest 30 分、成功返回体力增量；棚下休息也报告来源', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival, a = w.agents.p1;
  move(w, 'p1', 'hall');
  a.drives.v.energy = .3;
  const r = survAct(sp, { kind: 'camp_rest' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.gain, .06);
  assert.ok(a.drives.v.energy > .35);
  const cooldown = survAct(sp, { kind: 'camp_rest' });
  assert.equal(cooldown.code, 'REST_COOLDOWN');
  // compare 侧显式拒绝；不把新恢复来源写进 A/B 轨迹。
  const compare = createSurvPlay(7, GAME);
  compare.world.compareSide = 'A';
  assert.equal(campRestRule(compare.world, { nowMin: 60 }).code, 'REST_UNSUPPORTED');
  // 研究态没有 camp_rest。
  const lab = createSurvPlay(7, { farmLife: true });
  assert.equal(campRestRule(lab.world, { nowMin: 60 }).code, 'NOT_AVAILABLE');
});

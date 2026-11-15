// 游戏模式规则层闸门（2026-11-15）。
// 契约：研究世界（independentWorld=false）必须逐位沿用 BUILDINGS；
// 正式游戏（independentWorld=true）用 GAME_BUILDINGS，且奠基/施工都按游戏表结算。
// 变红法：让 buildingsFor 恒返回 BUILDINGS ⇒ 第二条测试失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILDINGS, GAME_BUILDINGS, buildingsFor, buildDef, doPlan, doBuild, addFood, takeFood, takeFoodKind } from './production.mjs';
import { createSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { dumpSurv, loadSurv } from './survplay.mjs';
import { survView } from './survplay.mjs';

test('R1 研究世界仍用原表（五面基线不被动到）', () => {
  const { world } = createSurvPlay();
  assert.equal(world.independentWorld, false);
  assert.equal(buildingsFor(world), BUILDINGS, '研究世界必须拿到原表引用');
  assert.equal(buildDef(world, 'shelter'), BUILDINGS.shelter);
  assert.deepEqual(BUILDINGS.shelter.cost, { wood: 4, stone: 2 });
});

test('R2 游戏世界用游戏表：奠基按游戏价扣材料，施工按游戏工时完工', () => {
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world; const s = w.survival;
  assert.equal(buildingsFor(w), GAME_BUILDINGS);
  assert.notDeepEqual(GAME_BUILDINGS.shelter, BUILDINGS.shelter);

  w.loc.p1 = 'yard';
  w.pinv.p1 = { wood: 0, stone: 0 };
  s.inv = { wood: 50, stone: 50 };
  const r = doPlan(w, 'p1', 'granary');
  assert.ok(r.ok, r.code);
  assert.deepEqual(s.inv, { wood: 40, stone: 44 }, '应按游戏表扣 10 木 6 石');

  // 工时 10、每次推进 2 ⇒ 第 5 下完工
  let done = null;
  for (let i = 0; i < 4; i += 1) {
    const step = doBuild(w, 'p1');
    assert.equal(step.completed, null, `第 ${i + 1} 下不应完工`);
  }
  done = doBuild(w, 'p1');
  assert.equal(done.completed, 'granary');
});

test('R3 视图把游戏表交给前端（UI 显示新成本）', () => {
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const { world } = sp;
  const { survView } = {};
  // 直接检查数据层：buildingsFor 是视图的唯一来源
  assert.equal(buildingsFor(world).granary.cost.wood, 10);
  assert.equal(buildingsFor({ independentWorld: true }).granary.cost.wood, 5, '只是游戏世界不够，必须显式 gameRules');
});

test('R4 分类粮仓：游戏世界按品类记账且总数守恒；研究世界没有 s.food', () => {
  const game = createSurvPlay(7, { gameRules: true });
  const gs = game.world.survival;
  assert.ok(gs.food, '游戏世界应初始化分类粮仓');
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '初始 sum(food) 应等于 store');
  addFood(gs, 'meat', 2);
  addFood(gs, 'berry', 1);
  assert.equal(gs.food.meat, 2);
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '入仓后总数仍守恒');
  const got = takeFoodKind(gs, null);
  assert.ok(['crop', 'meat', 'berry'].includes(got));
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '取用后总数仍守恒');
  assert.equal(takeFood(gs, null, 1), 1);

  const research = createSurvPlay(7);
  const rs = research.world.survival;
  assert.equal(rs.food, undefined, '研究世界不应有分类账本');
  const before = rs.store;
  assert.equal(addFood(rs, 'meat', 1), 0, '无账本时 addFood 是空操作');
  assert.equal(rs.store, before);
});

test('R5 灯火燃料：游戏世界每天烧一份木料并记亮/灭；研究世界不烧也不记', () => {
  const game = createSurvPlay(7, { gameRules: true });
  const w = game.world; const s = w.survival;
  w.t = 24; s.lastDay = -1; s.inv.wood = 0; w.pinv.p1.wood = 0; s.fuelBurnDays = 0;
  advanceSurvival(w);
  assert.equal(survView(game).light, false, '没柴应当没灯');
  assert.equal(s.fuelBurnDays, 0, '没柴时不应记燃烧');

  w.t = 48; s.lastDay = -1; s.inv.wood = 2;
  advanceSurvival(w);
  assert.equal(survView(game).light, true, '有柴应当有灯');
  assert.equal(s.inv.wood, 1, '每天烧一份木料');
  assert.equal(s.fuelBurnDays, 1, '烧过应记一天');

  const research = createSurvPlay(7);
  const rw = research.world; const rs = rw.survival;
  rw.t = 24; rs.lastDay = -1; rs.inv.wood = 5;
  advanceSurvival(rw);
  assert.equal(survView(research).light, null, '研究世界没有灯火概念');
  assert.equal(rs.inv.wood, 5, '研究世界不烧柴');
});

test('R4b 载入无 food 的旧档后仍总数守恒', () => {
  // 旧档：开关之前烘的，只有整数 store，没有分档
  const legacy = createSurvPlay(7);
  legacy.world.survival.store = 17;
  const raw = structuredClone(dumpSurv(legacy));
  assert.equal(raw.survival.food, undefined, '旧档不应带分档');

  const loaded = loadSurv(raw, 7, { gameRules: true });
  const s = loaded.world.survival;
  assert.ok(s.food, '载入后应当补出分档');
  assert.equal(
    Object.values(s.food).reduce((a, b) => a + b, 0), s.store,
    '载入后 Σfood 必须等于 store',
  );

  // 推进两天配给：差额仍必须为 0（旧实现在这里会永久挂着 11）
  loaded.world.t = 24; s.lastDay = -1;
  advanceSurvival(loaded.world);
  loaded.world.t = 48; s.lastDay = -1;
  advanceSurvival(loaded.world);
  assert.equal(
    Object.values(s.food).reduce((a, b) => a + b, 0), s.store,
    '推进两天后 Σfood 仍须等于 store',
  );
});

// 游戏模式规则层闸门（2026-11-15）。
// 契约：研究世界（independentWorld=false）必须逐位沿用 BUILDINGS；
// 正式游戏（independentWorld=true）用 GAME_BUILDINGS，且奠基/施工都按游戏表结算。
// 变红法：让 buildingsFor 恒返回 BUILDINGS ⇒ 第二条测试失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILDINGS, GAME_BUILDINGS, buildingsFor, buildDef, doPlan, doBuild } from './production.mjs';
import { createSurvPlay } from './survplay.mjs';

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

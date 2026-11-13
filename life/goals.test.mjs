// 派单§七 多步骤行动组合实验（T11）。复用 validate/actuate；≥2 示范目标；中途改条件验重规划。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { move, actuate } from './body.mjs';
import { planGoal, goalProgress, executeGoalStep, GOALS } from './goals.mjs';

test('T11a 住所目标：多步骤组合（采木→采石→奠基→施工）自主完工', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.survival.resStock.yard = 12; w.survival.resStock.watch = 10;
  move(w, 'a1', 'yard');
  assert.ok(GOALS.shelter.steps.length >= 3, '住所目标应为多步骤');
  let n = 0;
  while (goalProgress(w, 'a1', 'shelter') < 1 && n < 100) {
    const r = executeGoalStep(w, 'a1', 'shelter');
    if (!r.ok && r.code === 'NO_STEP') break;
    n += 1;
  }
  assert.ok(w.survival.buildings.some((b) => b.type === 'shelter' && b.integrity > 0), `住所应建成（${n} 步）`);
  assert.equal(goalProgress(w, 'a1', 'shelter'), 1);
  assert.equal(planGoal(w, 'a1', 'shelter'), null, '完成后无下一步');
});

test('T11b 中途改条件重规划：材料被拿走后回到采集步骤', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.survival.resStock.yard = 12; w.survival.resStock.watch = 10;
  move(w, 'a1', 'yard');
  executeGoalStep(w, 'a1', 'shelter'); // 采木 +2
  assert.equal(planGoal(w, 'a1', 'shelter').kind, 'gather', '木不够应继续采木');
  w.pinv.a1.wood = 4; // 木满足⇒推进到采石（需移动去石料点）
  const p2 = planGoal(w, 'a1', 'shelter');
  assert.equal(p2.kind, 'move_to'); assert.equal(p2.to, 'watch');
  w.pinv.a1.wood = 0; // 中途拿走木⇒重规划回采木
  const p3 = planGoal(w, 'a1', 'shelter');
  assert.equal(p3.kind, 'gather', '材料变化应重规划回采木');
});

test('T11c 食物目标：采浆果→去公仓兑换，公仓实际增加', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.survival.store = 0; w.survival.produce.berry = 0;
  move(w, 'a1', 'yard');
  assert.equal(planGoal(w, 'a1', 'food').kind, 'forage');
  executeGoalStep(w, 'a1', 'food'); // 采浆果
  assert.ok(w.survival.produce.berry >= 1);
  const p2 = planGoal(w, 'a1', 'food');
  assert.equal(p2.kind, 'move_to'); assert.equal(p2.to, 'store');
  executeGoalStep(w, 'a1', 'food'); // 去公仓
  assert.equal(planGoal(w, 'a1', 'food').kind, 'exchange');
  executeGoalStep(w, 'a1', 'food'); // 兑换
  assert.ok(w.survival.store >= 1, '兑换应增加公仓');
});

test('T11d 资源稀缺负控：采集点全采空时目标等待，不凭空采集', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.survival.resStock = { yard: 0, garden: 0, watch: 0, well: 0 };
  move(w, 'a1', 'yard');
  assert.equal(planGoal(w, 'a1', 'shelter'), null, '资源采空应等待再生，不伪造采集');
  const r = executeGoalStep(w, 'a1', 'shelter');
  assert.equal(r.ok, false); assert.equal(r.code, 'NO_STEP');
  assert.equal(w.pinv.a1.wood, 0, '不应凭空获得木料');
});
test('T23 住所奠基消耗最后一批材料后继续施工，完成后目标结束', () => {
  const w = createSurvPlay(7).world;
  w.survival.inv = { wood: 0, stone: 0 };
  w.pinv.a1 = { wood: 4, stone: 2 };
  move(w, 'a1', 'yard');
  assert.equal(planGoal(w, 'a1', 'shelter').kind, 'plan');
  assert.ok(actuate(w, 'a1', { kind: 'plan', type: 'shelter' }).ok);
  assert.deepEqual(w.pinv.a1, { wood: 0, stone: 0 });
  assert.equal(planGoal(w, 'a1', 'shelter').kind, 'build');
  while (planGoal(w, 'a1', 'shelter')) assert.ok(executeGoalStep(w, 'a1', 'shelter').ok);
  assert.equal(goalProgress(w, 'a1', 'shelter'), 1);
  assert.deepEqual(w.pinv.a1, { wood: 0, stone: 0 });
});

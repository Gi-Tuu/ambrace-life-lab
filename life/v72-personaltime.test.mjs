// V7.2 阶段 B 第 2 步：玩家不再受"每刻 100 点"限制；时间按一天累计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('B-STEP2 同一刻可连续完成多个动作，不再返回 ACTION_BUDGET', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world; w.survival.actTimeModel = true;
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(survAct(sp, { kind: 'move', room: i % 2 ? 'yard' : 'hall' }));
  assert.equal(results.filter((r) => r.ok).length, 4, JSON.stringify(results));
  assert.ok(results.every((r) => r.code !== 'ACTION_BUDGET'));
  assert.equal(w.t, 0, '玩家连续动作不应偷偷推进世界刻');
});

test('B-STEP2 一天时间用尽后返回 TIME_WAIT，而不是永久锁死', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world; w.survival.actTimeModel = true;
  w.survival.actClock.p1.usedMin = 1430;
  const r = survAct(sp, { kind: 'move', room: 'yard' }); // 25 分
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIME_WAIT');
  // 次日恢复
  w.t = 24;
  const r2 = survAct(sp, { kind: 'move', room: 'yard' });
  assert.equal(r2.ok, true);
});

test('B-STEP2 失败不扣个人时间（误点不吃当天时间）', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world; w.survival.actTimeModel = true;
  const before = w.survival.actClock.p1.usedMin;
  const bad = survAct(sp, { kind: 'camp_eat', type: 'crop' }); // 不在家/公仓，失败
  assert.equal(bad.ok, false);
  assert.equal(w.survival.actClock.p1.usedMin, before);
});

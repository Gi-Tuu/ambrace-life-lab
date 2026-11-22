// V7.2 阶段 B 第 2 步：玩家不再受"每刻 100 点"限制；时间按一天累计。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';
import { clockOf } from './resident-time.mjs';

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

test('B-STEP2-TIME-WAIT 本刻 60 分钟用尽后返回 TIME_WAIT，下一拍恢复（V7.3 每刻池）', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world; w.survival.actTimeModel = true;
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 60, n: 0 };
  const r = survAct(sp, { kind: 'move', room: 'yard' }); // 5 分，装不下
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIME_WAIT');
  // 下一世界刻重置本刻池
  w.t += 1;
  const r2 = survAct(sp, { kind: 'move', room: 'yard' });
  assert.equal(r2.ok, true);
});

test('B-STEP2-FAIL-NO-CHARGE 失败不扣个人时间（误点不吃当天时间）', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world; w.survival.actTimeModel = true;
  const before = clockOf(w, 'p1').tick.usedMin;
  const bad = survAct(sp, { kind: 'camp_eat', type: 'crop' }); // 不在家/公仓，失败
  assert.equal(bad.ok, false);
  assert.equal(clockOf(w, 'p1').tick.usedMin, before);
});


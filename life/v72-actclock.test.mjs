// V7.2 阶段 B 第 1 步：个人时间数据层——只建账，不改行动判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('B-STEP1 正式游戏每个角色都有个人时间账，且存读档一致', () => {
  const sp = createSurvPlay(7, GAME);
  const clock = sp.world.survival.actClock;
  assert.ok(clock, '正式游戏应有 actClock');
  for (const id of Object.keys(sp.world.agents)) {
    assert.deepEqual(clock[id], { day: 0, usedMin: 0, busy: null });
  }
  clock.p1.usedMin = 90;
  const restored = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  assert.equal(restored.world.survival.actClock.p1.usedMin, 90, 'usedMin 应随档恢复');
});

test('B-STEP1 旧正式档缺 actClock 时补账，不拒绝载入', () => {
  const sp = createSurvPlay(7, GAME);
  const raw = structuredClone(dumpSurv(sp));
  delete raw.survival.actClock;
  const restored = loadSurv(raw, 7, GAME);
  assert.ok(restored.world.survival.actClock, '应补出个人时间账');
  assert.equal(restored.world.survival.actClock.p1.usedMin, 0);
});

test('B-STEP1 研究态不写入 actClock（基线逐位不变）', () => {
  const research = createSurvPlay(7, { ...GAME, gameRules: false, independentWorld: false });
  assert.equal(research.world.survival.actClock, undefined);
  const d = dumpSurv(research);
  assert.equal(Object.hasOwn(d.survival, 'actClock'), false);
});

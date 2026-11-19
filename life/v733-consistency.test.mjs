// V7.3.3 P1/P2：观测器、窗口、动态居民、代谢路径、账本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvent, createActionObserver } from './action-observer.mjs';
import { measureIdle } from './idle-probe.mjs';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { move, isAlive } from './body.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('V733-OBS 观测器去重/限长/不耗随机数', () => {
  const o = createActionObserver({ cap: 3 });
  const e = actionEvent({ actorId: 'a1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10, actualEnergy: .03 });
  assert.equal(o.feed(e), true);
  assert.equal(o.feed({ ...e }), false, '同键去重');
  for (let i = 0; i < 5; i += 1) o.feed(actionEvent({ actorId: 'a1', worldTick: 6 + i, kind: 'move', status: 'completed' }));
  assert.equal(o.events.length, 3, '限长');
  assert.equal(o.dropped(), 3);
});

test('V733-WIN 窗口=日×24 刻；1/2 日边界精确', async () => {
  const r1 = await measureIdle(7, 1);
  assert.equal(r1.ticksRun, 24, '1 日必须 24 刻');
  assert.equal(r1.actualDays, 1);
  const r2 = await measureIdle(7, 2);
  assert.equal(r2.ticksRun, 48, '2 日必须 48 刻');
  assert.equal(r2.actualDays, 2);
});



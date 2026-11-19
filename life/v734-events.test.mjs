// V7.3.4 D：真实 Organism 状态级事件延续（pending/informedTick/busy/无机会/第二 episode/读档）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('V734-D 无机会刻：pending 只消费一次、informedTick 清空、不触发反射/习惯', async () => {
  process.env.FAIR_SCHED = '1'; process.env.FAIR_DECISION_CAP = '1';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.pending.push({ for: 'a2', evt: { kind: 'contact', tag: 'v734', valence: 0.3, selfCaused: false } });
  w.agents.a2.informedTick = w.t + 1;
  const r0 = w.agents.a2.counters.reflex ?? 0, h0 = w.agents.a2.counters.habit ?? 0;
  await tickSurvPlay(sp);
  assert.equal(w.pending.some((p) => p.for === 'a2' && p.evt?.tag === 'v734'), false, 'pending 必须被消费且不重复');
  assert.equal(w.agents.a2.informedTick, null, 'informedTick 必须清空且只一次');
  assert.equal(w.agents.a2.counters.reflex ?? 0, r0, '无机会不得触发反射');
  assert.equal(w.agents.a2.counters.habit ?? 0, h0, '无机会不得触发习惯');
  await tickSurvPlay(sp);
  assert.equal(w.pending.some((p) => p.for === 'a2' && p.evt?.tag === 'v734'), false, '第二刻不得重复评价');
});

test('V734-D busy 时 pending 仍消费一次、busy 保留', async () => {
  process.env.FAIR_SCHED = '0';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'a1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.a1 = { wood: 5, stone: 5 };
  clockOf(w, 'a1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(w.agents.a1.execute(w, { kind: 'build' }, 'deliberation', w.t, true).code, 'BUSY_START');
  const id = w.t + 1;
  w.pending.push({ for: 'a1', evt: { kind: 'contact', tag: 'v734', valence: 0.2, selfCaused: false } });
  w.agents.a1.informedTick = id;
  await tickSurvPlay(sp);
  assert.equal(w.pending.some((p) => p.for === 'a1' && p.evt?.tag === 'v734'), false);
  assert.equal(w.agents.a1.informedTick, null);
  assert.ok(w.agents.a1.lastMetab);
  assert.ok(clockOf(w, 'a1').busy || w.agents.a1.dead, 'busy 不得被 pending 取消');
});

test('V734-D 第二 episode 不重复基础/评价；读档首刻 pending 只消费一次', async () => {
  process.env.FAIR_SCHED = '0';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.pending.push({ for: 'a1', evt: { kind: 'contact', valence: 0.2, selfCaused: false } });
  await tickSurvPlay(sp);
  assert.equal(w.pending.some((p) => p.for === 'a1' && p.evt?.tag === 'v734'), false);
  const n = w.agents.a1.metabCount ?? 0;
  await w.agents.a1.tick(w);
  assert.equal((w.agents.a1.metabCount ?? 0) - n, 0, '第二 episode 不重复代谢');
  // 读档首刻
  const sp2 = createSurvPlay(7, GAME), w2 = sp2.world;
  w2.pending.push({ for: 'a2', evt: { kind: 'contact', tag: 'v734', valence: 0.2, selfCaused: false } });
  const back = loadSurv(structuredClone(dumpSurv(sp2)), 7, GAME);
  await tickSurvPlay(back);
  assert.equal(back.world.pending.some((p) => p.for === 'a2' && p.evt?.tag === 'v734'), false, '读档后 pending 只消费一次');
  process.env.FAIR_SCHED = '0'; process.env.FAIR_DECISION_CAP = '8';
});



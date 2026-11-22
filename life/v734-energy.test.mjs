// V7.3.4 C：跨刻体力按剩余应付累计，提前结束保留已用，读档不重复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf, advanceResidentBusy } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };
const setup = (used = 55, energy = 1) => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'a1', 'yard');
  w.survival.lastDay = 0;
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.a1 = { wood: 5, stone: 5 };
  w.agents.a1.drives.v.energy = energy;
  clockOf(w, 'a1').tick = { t: w.t, usedMin: used, n: 0 };
  return { sp, w };
};

test('V734-E 5+25 与 10+20 总体力=0.10，按进度累计', () => {
  for (const used of [55, 50]) {
    const { w } = setup(used);
    const a = w.agents.a1;
    const e0 = a.drives.v.energy;
    assert.equal(a.execute(w, { kind: 'build' }, 'deliberation', w.t, true).code, 'BUSY_START');
    w.t += 1;
    const r = advanceResidentBusy(w, 'a1');
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.ok(Math.abs((e0 - a.drives.v.energy) - 0.10) < 1e-9, 'used=' + used + ' 体力应=0.10，实测 ' + (e0 - a.drives.v.energy));
  }
});

test('V734-E-ABORT 提前中止保留已用；体力不足按本段判断；读档不重复', () => {
  const { w } = setup(55, 0.04);
  const a = w.agents.a1;
  assert.equal(a.execute(w, { kind: 'build' }, 'deliberation', w.t, true).code, 'BUSY_START');
  const dayUsed = clockOf(w, 'a1').usedMin;
  w.t += 1;
  const ab = advanceResidentBusy(w, 'a1');
  assert.equal(ab.aborted, true);
  assert.equal(ab.code, 'STAMINA');
  assert.ok(clockOf(w, 'a1').usedMin >= dayUsed, '已用分钟不得退回');
  const s2 = setup(50), w2 = s2.w;
  const b = w2.agents.a1;
  assert.equal(b.execute(w2, { kind: 'build' }, 'deliberation', w2.t, true).code, 'BUSY_START');
  const e1 = b.drives.v.energy;
  const back = loadSurv(structuredClone(dumpSurv(s2.sp)), 7, GAME);
  const bb = back.world.agents.a1;
  back.world.t += 1;
  const r = advanceResidentBusy(back.world, 'a1');
  assert.equal(r.completed, true);
  assert.ok(Math.abs((e1 - bb.drives.v.energy) - 0.10) < 1e-9, '读档后总扣体力仍=0.10');
});


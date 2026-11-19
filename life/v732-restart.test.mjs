// V7.3.2 重启一致性：fair on/off 读档后 usedMin/busy/debt/last/机会连续，不重复代谢。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { clockOf } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { isAlive } from './body.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

function snapshot(sp) {
  const w = sp.world;
  return {
    t: w.t, store: w.survival.store,
    clocks: Object.fromEntries(Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => {
      const c = clockOf(w, a.id);
      return [a.id, { usedMin: c.usedMin, tick: c.tick?.usedMin ?? 0, busy: !!c.busy }];
    })),
    fair: w.fairSched ? { debt: { ...w.fairSched.debt }, last: { ...w.fairSched.last }, cap: w.fairSched.cap } : null,
  };
}

test('V732-RESTART fair off：读档后 usedMin/busy 连续，首刻代谢恰好一次', async () => {
  process.env.FAIR_SCHED = '0';
  const sp = createSurvPlay(7, GAME);
  for (let i = 0; i < 5; i += 1) await tickSurvPlay(sp);
  const before = snapshot(sp);
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  const after = snapshot(back);
  assert.deepEqual(after.clocks, before.clocks, 'off：usedMin/tick/busy 必须连续');
  for (const a of Object.values(back.world.agents)) {
    if (a.isPlayer || !isAlive(a)) continue;
    const n = a.metabCount ?? 0;
    await tickSurvPlay(back);
    assert.equal((a.metabCount ?? 0) - n, 1, `${a.id} 读档首刻代谢应恰好 +1`);
    break;
  }
});



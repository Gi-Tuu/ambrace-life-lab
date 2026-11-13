// P0-C 生命连续性：连续运行 vs 中途读档，核心状态逐刻一致；RNG 进度可存档恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from './rng.mjs';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';

const GAME = { residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true };

function sig(sp) {
  const w = sp.world;
  const agents = Object.fromEntries(Object.values(w.agents).filter((a) => a.drives && a.viab).map((a) => [a.id, {
    m: a.bank.snapshot(), pending: { ...a.bank.pending },
    drives: { ...a.drives.v }, setpoint: { ...a.drives.setpoint }, aloneTicks: a.drives.aloneTicks,
    counters: { ...a.counters }, dayTally: structuredClone(a.dayTally),
    viab: a.viab.dump(), rng: a.rng?.state?.() ?? null,
    memory: a.memory.dump(), rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling,
    habit: a.habit.dump(), forwardModel: a.forwardModel.dump(),
    m3Last: a.m3Last, m3PrevGoal: a.m3PrevGoal, dead: !!a.dead,
  }]));
  return JSON.stringify({
    t: w.t, loc: w.loc, pinv: w.pinv, housing: w.housing, sex: w.sex, pending: w.pending,
    agents,
    survival: { ...w.survival, talk: null },
  });
}

test('C4 连续 240 刻 vs 120 刻存档再跑 120 刻：核心状态一致（seed 7/13/29）', async () => {
  for (const seed of [7, 13, 29]) {
    const a = createSurvPlay(seed, GAME);
    const frames = [];
    for (let i = 0; i < 240; i += 1) { await tickSurvPlay(a); frames.push(sig(a)); }

    const b = createSurvPlay(seed, GAME);
    for (let i = 0; i < 120; i += 1) await tickSurvPlay(b);
    const restored = loadSurv(JSON.parse(JSON.stringify(dumpSurv(b))), seed, GAME);
    let first = null;
    for (let i = 120; i < 240; i += 1) {
      await tickSurvPlay(restored);
      const got = sig(restored);
      if (got !== frames[i] && first === null) first = { tick: restored.world.t, got, want: frames[i] };
      if (first) break;
    }
    assert.equal(first, null, first ? `seed ${seed} 首次分歧在第 ${first.tick} 刻` : '');
  }
});

test('C2 RNG 状态可保存/恢复且不改变原序列', () => {
  const r = makeRng(7);
  const first = [r(), r(), r()];
  const st = r.state();
  const tail = [r(), r(), r()];
  const r2 = makeRng(999);
  r2.restore(st);
  assert.deepEqual([r2(), r2(), r2()], tail);
  const fresh = makeRng(7);
  assert.deepEqual([fresh(), fresh(), fresh()], first);
});

test('C3 旧档宽容：缺 RNG/调制/计数器/占位时按确定回退，不崩溃', async () => {
  const sp = createSurvPlay(7, GAME);
  for (let i = 0; i < 30; i += 1) await tickSurvPlay(sp);
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  for (const st of Object.values(raw.minds)) {
    delete st.rng; delete st.setpoint; delete st.bankPending; delete st.counters; delete st.dayTally;
    delete st.m3Planner; delete st.coupling; delete st.m3Last; delete st.m3PrevGoal;
  }
  delete raw.occupancy;
  const back = loadSurv(raw, 7, GAME);
  for (let i = 0; i < 5; i += 1) await tickSurvPlay(back);
  assert.equal(back.world.t, 35);
  assert.ok(back.world.agents.a1.counters.actions > 0);
  assert.ok(back.world.occupancy.home || back.world.loc.a1);
});

test('V3-10 正式游戏：反射刻也支付同一份基础代谢（反射不免代谢）', async () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  const a = w.agents.a1, b = w.agents.a2;
  a.drives.v.energy = 0.8; b.drives.v.energy = 0.8;
  for (let i = 0; i < 10; i += 1) {
    w.t += 1;
    w.percepts = [{ for: a.id, kind: 'alarm' }];
    await a.tick(w);
    w.percepts = [];
    await b.tick(w);
  }
  assert.ok(a.counters.reflex > 0, '样本里必须有反射接管');
  assert.equal(a.viab.age, 10, '反射角色也应支付 10 刻基础代谢年龄');
  assert.equal(b.viab.age, 10);
  assert.ok(a.viab.upkeepPaid > 0 && b.viab.upkeepPaid > 0);
  assert.ok(Math.abs(a.viab.upkeepPaid - b.viab.upkeepPaid) < 1e-9, `基础代谢不一致 ${a.viab.upkeepPaid} vs ${b.viab.upkeepPaid}`);
});

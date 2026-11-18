// V7.3.3 受控多代：原居民全灭只剩后代，cap1 下后代仍被登记/轮转/观测；读档再跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { isAlive } from './body.mjs';
import { ensureFairAgents } from './fair-sched.mjs';
import { actionEvent, createActionObserver } from './action-observer.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { ADULT_DAYS } from './households.mjs';
import { DAY_TICKS } from './clock.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

function makeOnlyDescendants() {
  process.env.FAIR_SCHED = '1'; process.env.FAIR_DECISION_CAP = '1';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  const h = w.survival.households;
  for (const [id, name, sex] of [['c1', '芽', 'F'], ['c2', '苗', 'M']]) {
    if (!w.agents[id]) {
      const a = new Organism({ id, name, archetype: '谨慎', seed: hashSeed(7, id + ':surv'), condition: 'C2' });
      w.agents[id] = a;
      w.loc[id] = 'home'; (w.occupancy.home ??= []).push(id);
      w.sex[id] = sex;
    }
    h.residents[id] = { born: w.t - ADULT_DAYS * DAY_TICKS, parents: ['a1', 'a2'], stage: 'adult' };
    h.spouses[id] = null;
  }
  for (const id of Object.keys(w.agents)) {
    if (id === 'c1' || id === 'c2' || w.agents[id].isPlayer) continue;
    const a = w.agents[id];
    a.viab.v = 0; a.dead = true; a.death = { t: w.t, day: 0, cause: 'TEST' };
    if (w.occupancy[w.loc[id]]) w.occupancy[w.loc[id]] = w.occupancy[w.loc[id]].filter((x) => x !== id);
  }
  return { sp, w };
}

test('V733-DESC 原居民全灭只剩后代：cap1 登记/轮转/debt/observer/无重复包装，读档复跑', async () => {
  const { sp, w } = makeOnlyDescendants();
  assert.ok(w.fairSched);
  ensureFairAgents(w); // 幂等：重复登记不得双重包装
  const observer = createActionObserver();
  const opp = { c1: 0, c2: 0 };
  for (let i = 0; i < 30; i += 1) {
    await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
      for (const r of rows) {
        const kind = r.kind ?? r.action?.kind;
        if (!kind) continue;
        observer.feed(actionEvent({ actorId: agent.id, worldTick: w.t, kind,
          status: r.ok === false ? 'failed' : 'completed', source: 'trace' }));
      }
    } });
    const eps = w.fairSched.episodes ?? {};
    const total = Object.values(eps).reduce((a, n) => a + n, 0);
    assert.ok(total <= 1, `cap1 每刻最多 1 个 episode，实测 ${total} @${w.t}`);
    for (const id of ['c1', 'c2']) if ((eps[id] ?? 0) > 0) opp[id] += eps[id];
    const fs = w.fairSched;
    for (const id of ['c1', 'c2']) {
      assert.ok(Object.hasOwn(fs.last, id) || fs.denied[id], `${id} 必须被登记进调度`);
    }
  }
  assert.ok(opp.c1 > 0 && opp.c2 > 0, `后代必须都获得机会：${JSON.stringify(opp)}`);
  assert.ok(Math.max(0, ...Object.values(w.fairSched.debt)) <= 2, 'debt 有界');
  // 无重复包装：再 tick 一次，机会只增加 1
  const before = w.fairSched.stats.opportunities;
  await tickSurvPlay(sp);
  assert.ok(w.fairSched.stats.opportunities - before <= 1, '不得双重包装导致多次机会');
  // 读档后复跑
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  const bw = back.world;
  assert.ok(bw.fairSched, '读档后 fair 仍安装');
  for (let i = 0; i < 5; i += 1) {
    await tickSurvPlay(back);
    const total = Object.values(bw.fairSched.episodes ?? {}).reduce((a, n) => a + n, 0);
    assert.ok(total <= 1, '读档后 cap1 仍每刻最多 1 个 episode');
  }
  assert.ok(['c1', 'c2'].every((id) => Object.hasOwn(bw.fairSched.last, id) || bw.fairSched.denied[id]));
  process.env.FAIR_SCHED = '0'; process.env.FAIR_DECISION_CAP = '8';
});



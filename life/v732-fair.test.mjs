// V7.3.2 全链路公平闸门：每刻每人最多 1 次 tick 机会、预算/轮转、决策链不追加、研究态不启用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fairBudget, installFairSched } from './fair-sched.mjs';
import { createSurvPlay } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

test('V732-FAIR 预算线性+上限', () => {
  assert.equal(fairBudget(1, 6), 1);
  assert.equal(fairBudget(4, 6), 4);
  assert.equal(fairBudget(12, 6), 6);
});

test('V732-FAIR 全链路：每刻≤1次 tick、轮转、决策链被挡', async () => {
  const ticks = [], chains = [];
  const mk = (id) => ({
    id, isPlayer: false, dead: false,
    async tick() { ticks.push([id, w.t]); return { ok: true }; },
    async decideOn() { chains.push([id, w.t]); return { id: 'x' }; },
  });
  const w = { t: 0, independentWorld: true, gameRules: true,
    agents: Object.fromEntries(['a1', 'a2', 'a3', 'a4'].map((id) => [id, mk(id)])) };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '2' });
  assert.ok(fs);
  for (const id of ['a1', 'a2', 'a3', 'a4']) await w.agents[id].tick();
  assert.equal(ticks.length, 2, '预算 2：本刻只有两人进入完整决策');
  assert.deepEqual(ticks.map(([id]) => id).sort(), ['a1', 'a2']);
  assert.equal(fs.stats.blockedTicks, 2);
  // 同刻第二次 tick 被挡
  await w.agents.a1.tick();
  assert.equal(ticks.length, 2);
  // tick 外的追加 decideOn（链）被挡
  await w.agents.a1.decideOn();
  assert.equal(chains.length, 0);
  assert.equal(fs.stats.blockedChains, 1);
  // 下一 tick 轮转到另外两人
  w.t += 1; ticks.length = 0;
  for (const id of ['a1', 'a2', 'a3', 'a4']) await w.agents[id].tick();
  assert.deepEqual(ticks.map(([id]) => id).sort(), ['a3', 'a4']);
});

test('V732-FAIR tick 内 decideOn 仍可用（同一次机会内）', async () => {
  const chains = [];
  const w = { t: 0, independentWorld: true, gameRules: true, agents: {} };
  w.agents.a1 = { id: 'a1', isPlayer: false, dead: false,
    async tick() { return this.decideOn(); },
    async decideOn() { chains.push(w.t); return { id: 'x' }; } };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '2' });
  await w.agents.a1.tick();
  assert.equal(chains.length, 1, 'tick 内的审议属于同一次机会');
  assert.equal(fs.stats.blockedChains, 0);
});

test('V732-FAIR 研究态/默认关不安装调度器', () => {
  const research = createSurvPlay(7, { unifiedCooperation: true, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.equal(research.world.fairSched, undefined);
  process.env.FAIR_SCHED = '1';
  const formal = createSurvPlay(7, { independentWorld: true, gameRules: true, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.ok(formal.world.fairSched, '正式游戏开启时应安装');
  process.env.FAIR_SCHED = '0';
});

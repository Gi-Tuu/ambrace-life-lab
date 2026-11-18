// V7.3.2 调度公平原型闸门：预算=min(cap,人口)、每刻每人≤1次、轮转、研究态不启用。
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

test('V732-FAIR 每刻每人最多 1 次、轮转、久闲优先', async () => {
  const calls = [];
  const mk = (id) => ({ id, isPlayer: false, dead: false, decideOn: async () => { calls.push([id, FAIR_T]); return { id }; } });
  let FAIR_T = 0;
  const w = { t: 0, independentWorld: true, gameRules: true, agents: Object.fromEntries(['a1', 'a2', 'a3', 'a4'].map((id) => [id, mk(id)])) };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '2' });
  assert.ok(fs);
  const act = async (id) => { FAIR_T = w.t; return w.agents[id].decideOn(); };
  await act('a1'); await act('a1'); // 同刻同一人第二次被挡
  await act('a2');
  const first = calls.map(([id]) => id).sort();
  assert.equal(calls.length, 2, '预算 2：只有两人本刻各一次');
  assert.equal(fs.stats.blocked, 1);
  // 下一 tick 轮转到另外两人（久闲优先）
  w.t += 1; calls.length = 0;
  for (const id of ['a1', 'a2', 'a3', 'a4']) await act(id);
  assert.deepEqual(calls.map(([id]) => id).sort(), ['a3', 'a4']);
});

test('V732-FAIR 研究态/默认关不安装调度器', () => {
  const research = createSurvPlay(7, { unifiedCooperation: true, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.equal(research.world.fairSched, undefined);
  process.env.FAIR_SCHED = '1';
  const formal = createSurvPlay(7, { independentWorld: true, gameRules: true, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.ok(formal.world.fairSched, '正式游戏开启时应安装');
  process.env.FAIR_SCHED = '0';
});

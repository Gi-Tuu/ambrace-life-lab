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
  // tick 外的追加 decideOn（链）属于同一 episode：放行、不计机会
  await w.agents.a1.decideOn();
  assert.equal(chains.length, 1);
  assert.equal(fs.stats.blockedChains, 0);
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

test('V732-FAIR debt：欠账高的先拿机会，获授后清零', async () => {
  const ticks = [];
  const mk = (id) => ({ id, isPlayer: false, dead: false, energy: 1,
    async tick() { ticks.push(id); },
    async decideOn() { return null; } });
  const w = { t: 0, independentWorld: true, gameRules: true, agents: Object.fromEntries(['a1', 'a2', 'a3', 'a4'].map((id) => [id, mk(id)])) };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '1' });
  fs.debt.a3 = 5; fs.debt.a4 = 2; // 手工欠账
  for (const id of ['a1', 'a2', 'a3', 'a4']) await w.agents[id].tick();
  assert.deepEqual(ticks, ['a3'], 'debt 最高者优先');
  assert.equal(fs.debt.a3, 0, '获授后清零');
  assert.equal(fs.debt.a4, 3, '未获授者欠账 +1');
});

test('V732-FAIR debt：cap 限制与 20 刻内无饥饿、debt 有界', async () => {
  const seen = new Map();
  const mk = (id) => ({ id, isPlayer: false, dead: false, energy: 1,
    async tick() { seen.set(id, (seen.get(id) ?? 0) + 1); },
    async decideOn() { return null; } });
  const w = { t: 0, independentWorld: true, gameRules: true, agents: Object.fromEntries(['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => [id, mk(id)])) };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '2' });
  for (let t = 0; t < 20; t += 1) { w.t = t; for (const a of Object.values(w.agents)) await a.tick(); }
  assert.deepEqual([...seen.keys()].sort(), ['a1', 'a2', 'a3', 'a4', 'a5'], '每个可行动者都拿到过机会');
  for (const n of seen.values()) assert.ok(n >= 6, `20 刻 cap2/5 人应至少 6 次，实测 ${n}`);
  assert.ok(Math.max(...Object.values(fs.debt)) <= 3, `debt 不得无限增长：${JSON.stringify(fs.debt)}`);
  assert.equal(fs.stats.blockedTicks, 60);
});

test('V732-FAIR episode：链不重复计机会、预算内可多次 episode、防单人刷满', async () => {
  let ticks = 0, chains = 0;
  const w = { t: 0, independentWorld: true, gameRules: true, agents: {
    a1: { id: 'a1', isPlayer: false, dead: false, async tick() { ticks += 1; await this.decideOn(); }, async decideOn() { chains += 1; } },
    a2: { id: 'a2', isPlayer: false, dead: false, async tick() { ticks += 1; }, async decideOn() { chains += 1; } },
  } };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '3' });
  await w.agents.a1.tick(); // 第一次 episode，链属于同一次
  await w.agents.a1.tick(); // 第二次：a2 还没有第一次 ⇒ 被挡（防刷满）
  await w.agents.a2.tick();
  assert.equal(ticks, 2, 'a1 第二次在 a2 首机会前被挡');
  await w.agents.a1.tick(); // 所有入选者都有第一次后，a1 可用剩余额度
  assert.equal(ticks, 3);
  assert.equal(fs.stats.extraEpisodes, 1);
  assert.equal(chains, 2, '链属于 episode，自身不额外计机会；第二次 episode 各带一次链');
  assert.equal(fs.stats.opportunities, 3);
});

test('V732-FAIR episode：超预算 debt 轮转，被挡者欠账', async () => {
  const ticks = [];
  const mk = (id) => ({ id, isPlayer: false, dead: false, async tick() { ticks.push(id); }, async decideOn() {} });
  const w = { t: 0, independentWorld: true, gameRules: true, agents: Object.fromEntries(['a1','a2','a3','a4','a5'].map((id) => [id, mk(id)])) };
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '2' });
  for (const a of Object.values(w.agents)) await a.tick();
  assert.equal(ticks.length, 2);
  assert.equal(Object.values(fs.debt).filter((v) => v === 1).length, 3, '被挡者 debt=1');
  w.t = 1; ticks.length = 0;
  for (const a of Object.values(w.agents)) await a.tick();
  const picked = new Set(ticks);
  assert.ok(picked.size <= 2);
  assert.ok([...picked].some((id) => fs.debt[id] === 0), '欠账者优先获授');
});


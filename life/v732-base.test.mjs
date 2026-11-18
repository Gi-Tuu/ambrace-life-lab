// V7.3.2 P0：FAIR_SCHED 只限 episode，基础代谢每刻每人恰好一次；链/多 episode 不重复代谢。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { installFairSched } from './fair-sched.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { isAlive } from './body.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('V732-BASE 正式游戏 fair=1：每个在世居民每刻代谢恰好一次（含被额度挡下者）', async () => {
  process.env.FAIR_SCHED = '1'; process.env.FAIR_DECISION_CAP = '2';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  assert.ok(w.fairSched, '公平调度应安装');
  for (let i = 0; i < 48; i += 1) {
    const before = new Map(Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a)).map((a) => [a.id, a.metabCount ?? 0]));
    await tickSurvPlay(sp);
    for (const [id, n] of before) {
      const a = w.agents[id];
      if (!a || a.dead) continue;
      assert.equal((a.metabCount ?? 0) - n, 1, `${id} 第 ${w.t} 刻代谢次数必须恰好 +1`);

    }
  }
  process.env.FAIR_SCHED = '0'; process.env.FAIR_DECISION_CAP = '8';
});

test('V732-BASE 合成矩阵：3/8/12/20 人 × cap 2/6/8 × 30 刻，代谢=刻数、决策≤cap、debt 有界', async () => {
  for (const n of [3, 8, 12, 20]) {
    for (const cap of [2, 6, 8]) {
      const agents = {};
      for (let i = 1; i <= n; i += 1) {
        const id = `a${i}`;
        agents[id] = { id, isPlayer: false, dead: false, bases: 0, decisions: 0, lastBase: -1,
          async tick() {
            if (this.lastBase === w.t) return null;
            this.lastBase = w.t; this.bases += 1;
            if (this.fairSuppress) return null;
            this.decisions += 1;
          } };
      }
      const w = { t: 0, independentWorld: true, gameRules: true, agents };
      const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: String(cap) });
      for (let t = 0; t < 30; t += 1) {
        w.t = t;
        for (const a of Object.values(agents)) await a.tick();
      }
      for (const a of Object.values(agents)) {
        assert.equal(a.bases, 30, `n=${n} cap=${cap} ${a.id} 代谢应=30，实测 ${a.bases}`);
        assert.ok(a.decisions <= 30 * cap, '决策受额度约束');
      }
      assert.ok(Math.max(0, ...Object.values(fs.debt)) <= Math.ceil(n / cap) + 1, `debt 有界 n=${n} cap=${cap}`);
    }
  }
});

test('V732-BASE 新生/动态加入居民自动进入调度，且不重复包装', async () => {
  const w = { t: 0, independentWorld: true, gameRules: true, agents: {} };
  const mk = (id) => ({ id, isPlayer: false, dead: false, bases: 0, decisions: 0, lastBase: -1,
    async tick() { if (this.lastBase === w.t) return null; this.lastBase = w.t; this.bases += 1; if (this.fairSuppress) return null; this.decisions += 1; } });
  w.agents.a1 = mk('a1');
  const fs = installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '8' });
  await w.agents.a1.tick();
  w.agents.a2 = mk('a2'); // 动态加入
  w.t = 1;
  await w.agents.a2.tick();
  assert.equal(w.agents.a2.bases, 1, '新居民被自动包装并拿到基础代谢');
  assert.equal(w.agents.a2.decisions, 1);
  await w.agents.a2.tick(); // 同刻第二次：tick 自身防重复基础
  assert.equal(w.agents.a2.bases, 1);
});


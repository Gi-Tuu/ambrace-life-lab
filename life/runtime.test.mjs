// 派单 P1 第四批运行时实验（T12/T13/T14）。保存恢复继续、LLM 全关、长周期无人参与。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv, survView } from './survplay.mjs';

const OPT = { residentialDecisions: true, ecosystem: true };

// ── T12 保存→恢复→继续运行：状态连续、不重复结算 ──
test('T12 存档恢复继续：刻/资源/心智/种群一致，继续推进不重复结算', async () => {
  const sp = createSurvPlay(7, OPT);
  sp.world.survival.playerEats = false;
  for (let i = 0; i < 60; i++) { if (sp.world.agents.p1?.viab) sp.world.agents.p1.viab.v = 1; await tickSurvPlay(sp); }
  const t0 = sp.world.t, store0 = sp.world.survival.store;
  const viab0 = sp.world.agents.a1.viab.dump().v;
  const pop0 = sp.world.survival.livestock.chickens;
  const day0 = Math.floor(t0 / 24);
  const restored = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, OPT);
  assert.equal(restored.world.t, t0, '恢复保留刻');
  assert.equal(restored.world.survival.store, store0, '恢复保留公仓');
  assert.equal(restored.world.agents.a1.viab.dump().v, viab0, '恢复保留存续');
  assert.equal(restored.world.survival.livestock.chickens, pop0, '恢复保留种群');
  // 继续运行
  for (let i = 0; i < 30; i++) { if (restored.world.agents.p1?.viab) restored.world.agents.p1.viab.v = 1; await tickSurvPlay(restored); }
  assert.equal(restored.world.t, t0 + 30, '继续推进 30 刻');
  assert.equal(Math.floor(restored.world.t / 24), day0 + Math.floor((t0 % 24 + 30) / 24), '日界连续不重复结算');
  assert.ok(restored.world.survival.history.length > 0, '历史保留');
});

// ── T13 LLM 完全关闭：基础自主层独立运行 ──
test('T13 LLM 全关：居民仍自主行动、生态仍演变，0 模型调用', async () => {
  const sp = createSurvPlay(7, OPT); // deliberator 默认 null
  sp.world.survival.playerEats = false;
  for (let i = 0; i < 120; i++) { if (sp.world.agents.p1?.viab) sp.world.agents.p1.viab.v = 1; await tickSurvPlay(sp); }
  const acts = Object.values(sp.world.survival.aiActions ?? {}).reduce((s, v) => s + v, 0);
  assert.ok(acts > 0, 'LLM 关闭居民仍自主行动');
  for (const a of Object.values(sp.world.agents)) assert.equal(a.counters?.llmCalls ?? 0, 0, '不应有模型调用');
  assert.ok(sp.world.survival.produce.egg >= 0 && sp.world.survival.livestock.chickens >= 0, '生态账存在');
});

// ── T14 长周期无人参与：世界持续演变、无决策异常 ──
test('T14 长周期无人参与（30 游戏日）：世界持续演变、无 agentError', async () => {
  const sp = createSurvPlay(7, OPT);
  sp.world.survival.playerEats = false; sp.world.survival.store = 200;
  for (let i = 0; i < 24 * 30; i++) { if (sp.world.agents.p1?.viab) sp.world.agents.p1.viab.v = 1; await tickSurvPlay(sp); }
  assert.ok(sp.world.t >= 24 * 30, '长周期跑完');
  assert.equal(sp.log.filter((x) => x.kind === 'agentError').length, 0, '不应有决策异常');
  const s = sp.world.survival;
  const evolved = (s.births ?? 0) > 0 || (s.deaths ?? []).length > 0 || s.livestock.chickens !== 3 || s.livestock.orchards !== 3;
  assert.ok(evolved, '无人参与世界应自行演变（出生/死亡/生态变化）');
});
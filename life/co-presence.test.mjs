// C 闸门：同处一地的成年人每天积累一点熟度（哪怕一方在途），且只在游戏态生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { stepRelationships, CO_PRESENCE_FAM } from './households.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('COP-01 同处一地（含在途）每天涨熟度，但不生成任何 talk 动作【变红法：把 gameRules 条件去掉】', () => {
  const sp = createSurvPlay(13, GAME); const w = sp.world;
  w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  w.survival.districtTravel = { a2: { from: 'home', to: 'yard', left: 1 } }; // a2 正在赶路：LIFE-02 下他不能开口
  const before = w.agents.a1.relations.get('a2').familiarity;
  w.t += 24; stepRelationships(w, sp.log);
  const after = w.agents.a1.relations.get('a2').familiarity;
  assert.ok(after > before, `同处一地应在一天后涨熟度，实测 ${before} → ${after}`);
  assert.ok(Math.abs(after - before - CO_PRESENCE_FAM) < 1e-9, `剂量必须是 ${CO_PRESENCE_FAM}，实测增量 ${(after - before).toFixed(4)}`);
  assert.equal(w.agents.a1.relations.get('a2').familiarity, after, '双向都要涨（同一次相遇是对称的）');
  const talked = Object.values(w.agents).some(a => (a.trace ?? []).some(r => r.t === w.t && String(r.action ?? '').startsWith('talk')));
  assert.equal(talked, false, '这条只积累熟度，不许代替 talk 动作或交付');
  // 同一天再跑一次不得重复积累（否则一 tick 一次会把剂量放大 24 倍）
  stepRelationships(w, sp.log);
  assert.equal(w.agents.a1.relations.get('a2').familiarity, after, '同一天内不得重复积累');
});

test('COP-02 研究态不得被动到（基线逐位不变的边界）【变红法：把条件改成恒真】', () => {
  const sp = createSurvPlay(13, { ...GAME, gameRules: false }); const w = sp.world;
  w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  const before = w.agents.a1.relations.get('a2').familiarity;
  w.t += 24; stepRelationships(w, sp.log);
  assert.equal(w.agents.a1.relations.get('a2').familiarity, before, '研究态不许积累同处熟度');
  assert.equal(w.survival.households.coFamiliarDay, undefined, '研究态不许写这个字段');
});

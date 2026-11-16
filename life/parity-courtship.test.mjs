// V7.1 P1 闸门：愿意但不同屋 ⇒ 登记求偶目标；同屋后按正常规则成婚；单向不愿意不撮合。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { stepRelationships } from './households.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

function makePair() {
  const sp = createSurvPlay(13, GAME);
  const w = sp.world;
  // 排除第三人干扰
  for (const id of ['a2']) { w.loc[id] = 'district-far-west'; }
  w.loc.a1 = 'yard';
  w.loc.a3 = 'workshop';
  // 双方都愿意（异性、成年）
  for (const [a, b] of [['a1', 'a3'], ['a3', 'a1']]) {
    w.agents[a].relations.meet(b, w.t, { delta: { trust: 60, familiarity: 1 } });
  }
  return { sp, w };
}

test('COURT-01 愿意但不同屋：登记求偶目标，且不瞬移成婚', () => {
  const { w } = makePair();
  stepRelationships(w, []);
  assert.equal(w.survival.households.courtship?.a1, 'a3', '应登记求偶目标');
  assert.equal(w.survival.households.spouses.a1, undefined, '不同屋不得直接成婚');
  assert.equal(w.loc.a1, 'yard', '不得瞬移');
});

test('COURT-02 同屋后按正常规则成婚（不需要额外条件）', () => {
  const { w } = makePair();
  stepRelationships(w, []);
  w.loc.a1 = 'workshop';
  stepRelationships(w, []);
  assert.equal(w.survival.households.spouses.a1, 'a3');
  assert.equal(w.survival.households.courtship?.a1, undefined, '成婚后清除求偶目标');
});

test('COURT-03 单向不愿意：不登记、不撮合', () => {
  const { w } = makePair();
  w.agents.a3.relations.meet('a1', w.t, { delta: { trust: -40, familiarity: -1 } });
  assert.ok(w.agents.a3.relations.get('a1').trust < 52);
  stepRelationships(w, []);
  assert.equal(w.survival.households.courtship?.a1, undefined);
  w.loc.a1 = 'workshop';
  stepRelationships(w, []);
  assert.equal(w.survival.households.spouses.a1, undefined);
});

// SOC-02 闸门：婚配性别规则对玩家与居民一致；玩家求婚同样要过居民意愿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

function pair(a, b) {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home'; w.loc[a] = 'home'; w.loc[b] = 'home';
  return { sp, w };
}

test('SOC-02a 同性婚配对双方一致：玩家也不能绕过（居民本来就被限制）', () => {
  const { sp, w } = pair('a1', 'a2');
  assert.equal(w.sex.p1, 'M');
  assert.equal(w.sex.a1, 'M');
  w.agents.a1.relations.meet('p1', w.t, { delta: { trust: 60, familiarity: 1 } });
  const r = survAct(sp, { kind: 'family_marry', target: 'a1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MARRIAGE_UNAVAILABLE');
  assert.equal(w.survival.households.spouses.a1, undefined, '不得成婚');
});

test('SOC-02b 异性、意愿满足 ⇒ 玩家可以成婚；意愿不足 ⇒ 被拒（不是一键）', () => {
  {
    const { sp, w } = pair('a3', 'a2');
    w.agents.a3.relations.meet('p1', w.t, { delta: { trust: 60, familiarity: 1 } });
    const r = survAct(sp, { kind: 'family_marry', target: 'a3' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(w.survival.households.spouses.a3, 'p1');
    assert.equal(w.survival.households.spouses.p1, 'a3');
  }
  {
    const { sp, w } = pair('a3', 'a2');
    const r = survAct(sp, { kind: 'family_marry', target: 'a3' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'OFFER_DECLINED');
    assert.equal(w.survival.households.spouses.a3, undefined);
  }
});

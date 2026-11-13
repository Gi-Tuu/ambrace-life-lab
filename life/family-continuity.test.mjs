import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, settleSurvival } from './survplay.mjs';
import { ADULT_DAYS, ELDER_DAYS, houseAction, maritalStatus, stepRelationships } from './households.mjs';
import { DAY_TICKS } from './clock.mjs';

const options = { residentialDecisions: true, independentWorld: true, eventRulesVersion: 2 };
const restore = sp => loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, options);
const marry = (w, a, b) => {
  w.loc[a] = w.loc[b] = 'home';
  for (const [from, to] of [[a, b], [b, a]]) {
    Object.assign(w.agents[from].relations.get(to), { trust: 70, familiarity: .8 });
  }
  return houseAction(w, a, { kind: 'family_marry', target: b });
};

test('V4-01–04 丧偶保留亲子和关系，可按现有条件再婚，重复结算不改历史', () => {
  const sp = createSurvPlay(7, options), w = sp.world, h = w.survival.households;
  assert.ok(marry(w, 'a1', 'a2').ok);
  h.residents.a3.parents = ['a1', 'a2'];
  h.offers.push({ from: 'a2', to: 'p1', kind: 'family_marry' });
  w.t = DAY_TICKS;
  w.agents.a2.viab.v = 0;
  assert.ok(settleSurvival(sp));
  assert.equal(maritalStatus(h, 'a1'), 'widowed');
  assert.deepEqual(h.marriages[0], { partners: ['a1', 'a2'], t: 0, remarried: [], ended: DAY_TICKS, deceased: ['a2'] });
  assert.deepEqual(h.residents.a3.parents, ['a1', 'a2']);
  assert.equal(w.agents.a1.relations.get('a2').trust, 70);
  assert.equal(h.offers.length, 0);
  assert.equal(settleSurvival(sp), false);
  const back = restore(sp), bw = back.world, bh = bw.survival.households;
  assert.deepEqual(bh.marriages, h.marriages);
  assert.deepEqual(bh.widowed, h.widowed);
  assert.equal(marry(bw, 'a1', 'a3').code, 'MARRIAGE_UNAVAILABLE');
  bh.residents.a3.parents = [];
  bh.residents.a3.born = bw.t - ELDER_DAYS * DAY_TICKS;
  assert.equal(marry(bw, 'a1', 'a3').code, 'MEET_REQUIRED');
  bh.residents.a3.born = bw.t - ADULT_DAYS * DAY_TICKS;
  bw.sex.a3 = 'F';
  stepRelationships(bw, back.log);
  assert.equal(bh.spouses.a1, 'a3');
  assert.equal(maritalStatus(bh, 'a1'), 'married');
  assert.deepEqual(bh.marriages[1].remarried, ['a1']);
});

test('V4-04 同刻双亡一次关闭婚姻，历史 V1 不迁移，旧 V2 读档补结算', () => {
  const sp = createSurvPlay(7, { ...options, eventRulesVersion: 1 }), w = sp.world;
  assert.ok(marry(w, 'a1', 'a2').ok);
  w.agents.a1.viab.v = w.agents.a2.viab.v = 0;
  settleSurvival(sp);
  const snapshot = JSON.parse(JSON.stringify(dumpSurv(sp)));
  assert.equal(loadSurv(snapshot, 7, options).world.survival.households.spouses.a1, 'a2');
  snapshot.eventRulesVersion = 2;
  const back = loadSurv(snapshot, 7, options), h = back.world.survival.households;
  assert.deepEqual(h.spouses, {});
  assert.deepEqual(h.marriages[0].deceased, ['a1', 'a2']);
  assert.equal(h.widowed, undefined);
  assert.equal(restore(back).world.survival.households.marriages.length, 1);
});


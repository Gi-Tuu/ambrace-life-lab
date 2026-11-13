import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, settleSurvival, tickSurvPlay, survAct } from './survplay.mjs';
import { ADULT_DAYS, ELDER_DAYS, houseAction, houseLabor, maritalStatus, stepRelationships, stepHouseholds } from './households.mjs';
import { validate } from './rules.mjs';
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



test('V4-05/06 59 岁开工、老年减产照常竣工，末次施工后死亡仍登记', () => {
  for (const die of [false, true]) {
    let sp = createSurvPlay(7, options);
    let w = sp.world, h = w.survival.households;
    h.residents.a1.born = -59 * DAY_TICKS;
    w.pinv.a1 = { wood: 5, stone: 3 };
    w.housing.a3 = 'house5';
    stepHouseholds(w, sp.log);
    const room = Object.keys(h.projects)[0];
    assert.ok(room);
    assert.deepEqual(w.pinv.a1, { wood: 0, stone: 0 });
    w.loc.a1 = 'workshop';
    assert.ok(houseLabor(w, 'a1', true));
    for (let day = 1; day <= 4; day++) {
      w.t = day * DAY_TICKS;
      assert.ok(houseLabor(w, 'a1', true));
      assert.equal(houseLabor(w, 'a1', true), false);
      assert.equal(h.projects[room].progress, 1 + day * .5);
    }
    if (die) {
      w.agents.a1.viab.v = 0;
      settleSurvival(sp);
    } else {
      w.t += DAY_TICKS;
      stepHouseholds(w, sp.log);
    }
    assert.equal(h.projects[room], undefined);
    assert.deepEqual(h.deeds[room], die ? { owner: null, listed: true } : { owner: 'a1' });
    assert.equal(h.housingHistory.filter(e => e.kind === 'finish').length, 1);
    sp = restore(sp);
    assert.deepEqual(sp.world.survival.households.deeds[room], h.deeds[room]);
  }
});

test('V4-06/07/10 暂停工程跨档，候选接续需做剩余劳动，无候选则释放地块', () => {
  for (const resume of [false, true]) {
    const sp = createSurvPlay(7, options), w = sp.world, h = w.survival.households;
    w.housing.a3 = 'house5';
    w.pinv.a1 = { wood: 5, stone: 3 };
    stepHouseholds(w, sp.log);
    const room = Object.keys(h.projects)[0];
    w.loc.a1 = 'workshop';
    assert.ok(houseLabor(w, 'a1', true));
    w.t = 4 * DAY_TICKS;
    stepHouseholds(w, sp.log);
    assert.equal(h.projects[room].progress, 1, '活着的工程所有者可暂停');
    w.agents.a1.viab.v = 0;
    settleSurvival(sp);
    assert.equal(h.projects[room].pausedAt, w.t);
    assert.equal(houseLabor(w, 'a1', true), false);
    const back = restore(sp), bw = back.world, bh = bw.survival.households;
    bh.residents.a2.decision = resume ? 'seeking' : 'stayed';
    bh.residents.a3.decision = 'stayed';
    bw.t += 3 * DAY_TICKS;
    stepHouseholds(bw, back.log);
    if (resume) {
      assert.equal(bh.projects[room].owner, 'a2');
      assert.equal(bh.projects[room].progress, 1);
      bw.loc.a2 = 'workshop';
      assert.ok(houseLabor(bw, 'a2', true));
      bw.t += DAY_TICKS;
      assert.ok(houseLabor(bw, 'a2', true));
      bw.t += DAY_TICKS;
      stepHouseholds(bw, back.log);
      assert.equal(bh.deeds[room].owner, 'a2');
    } else {
      assert.equal(bh.projects[room], undefined);
      assert.equal(bh.deeds[room], undefined);
      bw.housing.p1 = 'house2';
      bh.residents.a2.decision = 'seeking';
      bw.pinv.a2 = { wood: 5, stone: 3 };
      stepHouseholds(bw, back.log);
      assert.equal(bh.projects[room].owner, 'a2');
      assert.deepEqual(bw.pinv.a2, { wood: 0, stone: 0 });
    }
    assert.deepEqual(bw.pinv.a1, { wood: 0, stone: 0 });
  }
});

test('V4-08/09/10 配偶和成年子女依序继承，无继承人的在住公房腾空后挂牌', () => {
  const sp = createSurvPlay(7, options), w = sp.world, h = w.survival.households;
  assert.ok(marry(w, 'a1', 'a2').ok);
  h.residents.a3.parents = ['a1', 'a2'];
  const room = w.housing.a1;
  w.t = DAY_TICKS;
  w.agents.a1.viab.v = 0;
  settleSurvival(sp);
  assert.equal(h.deeds[room].owner, 'a2');
  w.t += DAY_TICKS;
  w.agents.a2.viab.v = 0;
  settleSurvival(sp);
  assert.equal(h.deeds[room].owner, 'a3');
  w.housing.p1 = room;
  w.t += DAY_TICKS;
  w.agents.a3.viab.v = 0;
  settleSurvival(sp);
  assert.deepEqual(h.deeds[room], { owner: null, listed: false });
  w.housing.p1 = 'house1';
  stepHouseholds(w, sp.log);
  assert.deepEqual(h.deeds[room], { owner: null, listed: true });
  const back = restore(sp);
  assert.deepEqual(back.world.survival.households.housingHistory, h.housingHistory);
  assert.deepEqual(back.world.survival.households.deeds, h.deeds);
});

test('V4-09 已故未成年子女不随迁，也不阻止三人房接纳一名配偶', () => {
  const sp = createSurvPlay(7, options), w = sp.world, h = w.survival.households;
  assert.ok(marry(w, 'a1', 'a2').ok);
  const from = w.housing.a1, to = w.housing.a2;
  w.housing.a3 = w.housing.p1 = to;
  w.agents.c1 = { id: 'c1', viab: { v: 0 }, dead: true };
  w.housing.c1 = from;
  h.residents.c1 = { born: 0, parents: ['a1', 'a2'] };
  assert.ok(houseAction(w, 'a1', { kind: 'family_move', target: 'a2' }).ok);
  assert.equal(w.housing.a1, to);
  assert.equal(w.housing.c1, from);
});


test('V4-12 分离伴侣独立冷却与单日出生上限，保留人口和粮门槛', async () => {
  const simulate = async (policy, cap = 10, store = 24) => {
    const sp = createSurvPlay(7, options), w = sp.world, h = w.survival.households;
    w.populationExperiment = { ...policy, residentCap: cap };
    assert.ok(marry(w, 'a1', 'a2').ok);
    assert.ok(marry(w, 'p1', 'a3').ok);
    w.sex.a3 = 'M';
    w.sex.p1 = 'F';
    w.housing.a2 = w.housing.a1;
    w.housing.a3 = w.housing.p1;
    w.t = DAY_TICKS - 1;
    w.survival.store = store;
    await tickSurvPlay(sp);
    return [sp, h];
  };
  for (const [policy, expected] of [[{}, 1], [{ pairCooldown: true, multipleBirths: false }, 1],
    [{ pairCooldown: true, multipleBirths: true }, 2]]) {
    const [sp, h] = await simulate(policy);
    assert.equal(sp.world.survival.births, expected);
    assert.deepEqual(h.residents.c1.parents, ['a1', 'a2']);
    if (expected === 2) assert.deepEqual(h.residents.c2.parents, ['a3', 'p1']);
    for (let i = 0; i < DAY_TICKS; i++) await tickSurvPlay(sp);
    assert.equal(sp.world.survival.births, policy.multipleBirths === false ? 2 : expected);
  }
  const [capped] = await simulate({ pairCooldown: true, multipleBirths: true }, 4);
  assert.equal(capped.world.survival.births, 1);
  const [short] = await simulate({ pairCooldown: true, multipleBirths: true }, 10, 4);
  assert.equal(short.world.survival.births ?? 0, 0);
});


test('V4-15 真实玩家采收同时结算背包、公仓和满仓丢弃', async () => {
  const sp = createSurvPlay(7, options), w = sp.world, s = w.survival;
  const flows = {};
  w.observeProduction = (channel, item, n) => { flows[channel + ':' + item] = n; };
  s.store = 23;
  s.plots[0].growth = 1;
  assert.ok(survAct(sp, { kind: 'move', room: 'garden' }).ok);
  assert.ok(survAct(sp, { kind: 'camp_collect', type: 'crop', tool: 'basket', plot: 0 }).ok);
  assert.equal(w.pinv.p1.crop, 1);
  assert.equal(s.store, 24);
  assert.equal(flows['food:crop'], 1);
  assert.equal(flows['collected:crop'], 1);
  assert.ok(flows['gross:crop'] > flows['food:crop'] + flows['collected:crop']);
  w.agents.a1.viab.v = 0;
  settleSurvival(sp);
  w.t = DAY_TICKS - 1;
  await tickSurvPlay(sp);
  assert.equal(s.history.at(-1).need, 3);
  assert.equal(flows['ration:store'], 3);
});


test('V4-05 私房施工经过 Organism 正常选择、规则验证、执行和存续扣费', async () => {
  const sp = createSurvPlay(13, options), w = sp.world, h = w.survival.households;
  w.housing.a3 = 'house5';
  w.pinv.a1 = { wood: 5, stone: 3 };
  stepHouseholds(w, sp.log);
  const room = Object.keys(h.projects)[0];
  assert.equal(validate(w, 'a1', { kind: 'house_work' }).code, 'NO_HOUSE_WORK');
  w.loc.a1 = 'workshop';
  assert.ok(validate(w, 'a1', { kind: 'house_work' }).ok);
  const actions = [];
  w.observeResidentAction = action => actions.push(action);
  for (let i = 0; i < 12 * DAY_TICKS && !h.deeds[room]; i++) await tickSurvPlay(sp);
  const labor = actions.filter(a => a.id === 'a1' && a.kind === 'house_work');
  assert.equal(labor.length, 3);
  assert.ok(labor.every(a => a.paid > 0));
  assert.equal(h.deeds[room].owner, 'a1');
});

// V7.2 第四批 C1 / C4 / E1：自然接触按真实位置、生命参数随档、生育统计口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { birthHomeStatus, stepRelationships, CO_PRESENCE_FAM, residentStage, ageDays, elderDaysFor } from './households.mjs';
import { worldSite } from './geometry.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const make = (seed = 13, extra = {}) => createSurvPlay(seed, { ...GAME, ...extra });
const fam = (w, a, b) => w.agents[a].relations.get(b).familiarity;
const nextDay = (w, sp) => { w.t += 24; stepRelationships(w, sp.log); };

test('C1-01 同处真实位置每天涨熟度，且玩家不再被排除', () => {
  const sp = make(), w = sp.world;
  w.loc.p1 = 'yard'; w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  w.survival.playerPos = null;
  const a1a2 = fam(w, 'a1', 'a2'), a1p1 = fam(w, 'a1', 'p1');
  nextDay(w, sp);
  assert.ok(fam(w, 'a1', 'a2') > a1a2, '居民之间应涨');
  assert.ok(fam(w, 'a1', 'p1') > a1p1, '玩家与居民之间也要涨（旧版把玩家排除了）');
  assert.ok(Math.abs(fam(w, 'a1', 'a2') - a1a2 - CO_PRESENCE_FAM) < 1e-9, '剂量保持每天一份');
  assert.equal(fam(w, 'a2', 'a1'), fam(w, 'a1', 'a2'), '双向对称');
});

test('C1-02 在途/跨区移动的人不站在任何一端：不算面对面', () => {
  const sp = make(), w = sp.world;
  w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  w.survival.districtTravel = { a2: { from: 'home', to: 'yard', left: 1 } };
  const before = fam(w, 'a1', 'a2');
  nextDay(w, sp);
  assert.equal(fam(w, 'a1', 'a2'), before, '逻辑 loc 相同但在途 ⇒ 不得积累');
});

test('C1-03 逻辑 loc 相同但真实位置不同，不算面对面；回到同处才涨', () => {
  const sp = make(), w = sp.world;
  w.loc.p1 = 'yard'; w.loc.a1 = 'yard';
  const site = worldSite(w, 'yard');
  w.survival.playerPos = { x: site[0] + 40, z: site[1] + 40, t: w.t };
  const before = fam(w, 'a1', 'p1');
  nextDay(w, sp);
  assert.equal(fam(w, 'a1', 'p1'), before, '逻辑 loc 相同但玩家在 40 格外 ⇒ 不得积累');
  w.survival.playerPos = { x: site[0] + 1, z: site[1] + 1, t: w.t };
  w.t += 24; stepRelationships(w, sp.log);
  assert.ok(fam(w, 'a1', 'p1') > before, '真实位置重合后才算见过');
});

test('C1-04 长期未见不涨：分开几天熟度不动', () => {
  const sp = make(), w = sp.world;
  w.loc.a1 = 'hall'; w.loc.a2 = 'yard';
  const before = fam(w, 'a1', 'a2');
  for (let i = 0; i < 3; i += 1) nextDay(w, sp);
  assert.equal(fam(w, 'a1', 'a2'), before, '不在同处就不该涨');
});

test('C1-05 研究态不得被动到（基线边界），也不写 coFamiliarDay', () => {
  const sp = make(13, { gameRules: false, actTimeModel: false }), w = sp.world;
  w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  const before = fam(w, 'a1', 'a2');
  nextDay(w, sp);
  assert.equal(fam(w, 'a1', 'a2'), before);
  assert.equal(w.survival.households.coFamiliarDay, undefined);
});

test('C4-01 正式游戏把生命参数写进存档；研究态不写', () => {
  const game = make().world;
  assert.deepEqual(game.survival.lifecycle, { infantDays: 3, adultDays: 12, elderDays: 90, elderDaysPlayer: 180 });
  const dump = dumpSurv(make());
  assert.ok(dump.survival.lifecycle, '正式档必须带 lifecycle');
  const research = createSurvPlay(7, { independentWorld: true }).world;
  assert.equal(research.survival.lifecycle, undefined, '研究态不得出现 lifecycle');
});

test('C4-02 读档按档恢复门槛：改当前默认也不突变；两次载入 age/stage 不变', () => {
  const sp = make(13, { lifecycle: { elderDays: 20, elderDaysPlayer: 40 } });
  const w = sp.world;
  w.survival.households.residents.a1.born = w.t - 25 * 24;
  assert.equal(residentStage(w, 'a1'), 'elder', '档内 20 天门槛 ⇒ 25 天是老年');
  assert.equal(elderDaysFor(w, 'p1'), 40);
  const once = loadSurv(structuredClone(dumpSurv(sp)), 13, GAME).world;
  const twice = loadSurv(structuredClone(dumpSurv({ world: once, log: [] })), 13, GAME).world;
  assert.equal(residentStage(once, 'a1'), 'elder', '读档后仍按档内门槛');
  assert.equal(ageDays(once, 'a1'), ageDays(w, 'a1'));
  assert.deepEqual([residentStage(twice, 'a1'), ageDays(twice, 'a1')], [residentStage(once, 'a1'), ageDays(once, 'a1')], '两次载入不得改变 age/stage');
});

test('C4-03 旧档缺 lifecycle：继承当前默认、不崩、不突变', () => {
  const sp = make(13), w = sp.world;
  w.survival.households.residents.a1.born = w.t - 25 * 24;
  const raw = structuredClone(dumpSurv(sp));
  delete raw.survival.lifecycle;
  const back = loadSurv(raw, 13, GAME).world;
  assert.equal(residentStage(back, 'a1'), 'adult', '缺字段 ⇒ 当前默认 60 天门槛');
  const again = loadSurv(structuredClone(dumpSurv({ world: back, log: [] })), 13, GAME).world;
  assert.deepEqual([residentStage(again, 'a1'), ageDays(again, 'a1')], [residentStage(back, 'a1'), ageDays(back, 'a1')]);
});

test('E1 生育条件成功时返回 {room, ok:true}，统计不再记 unknown', () => {
  const sp = make(), w = sp.world;
  const h = w.survival.households;
  h.spouses.a1 = 'a2'; h.spouses.a2 = 'a1';
  w.housing.a2 = w.housing.a1;
  const st = birthHomeStatus(w, 'a1', 'a2');
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.ok(st.room);
  // population-census 的键：成功必须是 'ok'，不得落到 unknown
  const key = st.ok ? 'ok' : (st.reason ?? 'unknown');
  assert.equal(key, 'ok');
  // 不满足条件时也必须是具体 reason，而不是 unknown
  w.housing.a2 = 'house4';
  const bad = birthHomeStatus(w, 'a1', 'a2');
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? 'ok' : (bad.reason ?? 'unknown'), 'residence');
});



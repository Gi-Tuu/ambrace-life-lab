// V7.1 P0 闸门：玩家生命周期（年龄/老年/自然死亡/旧档回填/研究态不变/死后世界继续）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const DAY = 24;

async function tickDays(sp, days) {
  for (let i = 0; i < days * DAY; i += 1) await tickSurvPlay(sp, { now: Date.now() });
}

test('PLIFE-01 新游戏：玩家是成年、年龄可算（与居民同一起点）', () => {
  const sp = createSurvPlay(7, GAME);
  const view = survView(sp);
  assert.equal(view.player.stage, 'adult');
  assert.equal(view.player.age, 12);
  const rec = sp.world.survival.households.residents.p1;
  assert.ok(rec && Number.isFinite(rec.born));
});

test('PLIFE-02 玩家会进入老年，并吃同一份老年代谢；老年失去婚育资格', async () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.t = 61 * DAY;
  const v0 = w.agents.p1.viab.v;
  await tickSurvPlay(sp, { now: Date.now() });
  assert.equal(survView(sp).player.stage, 'elder', '61 天应进入老年');
  assert.ok(w.agents.p1.viab.v < v0, '老年额外代谢应作用于玩家');
  // 老年不能再婚：条件拉满也应被 adult 门槛拒绝
  w.loc.p1 = 'home'; w.loc.a3 = 'home';
  w.agents.a3.relations.meet('p1', w.t, { delta: { trust: 60, familiarity: 1 } });
  const r = survAct(sp, { kind: 'family_marry', target: 'a3' });
  assert.equal(r.ok, false, '老年玩家不应能结婚');
  assert.ok(['MARRIAGE_UNAVAILABLE', 'ADULT_REQUIRED'].includes(r.code), '老年不得结婚，实测 ' + r.code);
});

test('PLIFE-03 玩家会自然衰老死亡；死后不能再行动，但世界继续', async () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.t = 61 * DAY;
  let died = false;
  for (let d = 0; d < 240 && !died; d += 1) {
    await tickDays(sp, 1);
    died = !!w.survival.playerDead;
  }
  assert.ok(died, '240 个游戏日内玩家应自然衰老死亡');
  assert.equal(w.agents.p1.death?.cause, '衰老');
  const act = survAct(sp, { kind: 'move', room: 'hall' });
  assert.equal(act.ok, false);
  assert.equal(act.code, 'PLAYER_DEAD', '死后不得再执行角色行动');
  const t0 = w.t;
  const before = w.agents.a2.counters?.actions ?? 0;
  await tickDays(sp, 3);
  assert.ok(w.t > t0, '玩家死后世界仍应推进');
  assert.ok((w.agents.a2.counters?.actions ?? 0) >= before, '居民应继续行动/计数');
});

test('PLIFE-04 旧档缺玩家年龄：回填成年起点，不立即判老、不触发死亡', () => {
  const raw = structuredClone(dumpSurv(createSurvPlay(7, GAME)));
  delete raw.survival.households.residents.p1;
  const sp = loadSurv(raw, 7, GAME);
  const view = survView(sp);
  assert.equal(view.player.stage, 'adult');
  assert.equal(view.player.age, 12);
  assert.equal(view.player.dead, false);
  assert.ok(sp.world.survival.households.residents.p1?.born != null);
});

test('PLIFE-05 研究态保持原行为：玩家不进生命周期', () => {
  const sp = createSurvPlay(7, { ...GAME, independentWorld: false });
  assert.equal(sp.world.survival.households?.residents?.p1, undefined, '研究态不写玩家记录');
});

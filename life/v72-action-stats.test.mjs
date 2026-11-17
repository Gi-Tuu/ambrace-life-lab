// V7.2 第四批 E2/E3：玩家与居民同一口径的行动账本（意图/成败/拒绝/中止/时间/体力/资源）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, survAct, tickSurvPlay } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf, advanceResidentBusy } from './resident-time.mjs';
import { runLong } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const make = (seed = 7) => createSurvPlay(seed, GAME);
const sum = (o) => Object.values(o ?? {}).reduce((a, n) => a + n, 0);

test('E2-01 服务端位置同步不进行动账本，更不影响劳动成功率', () => {
  const sp = make(), w = sp.world;
  w.t = 10;
  move(w, 'p1', 'yard');
  const before = sum(w.survival.actionLedger?.player?.attempt);
  survAct(sp, { kind: 'player_sync', from: [21, 24] });
  const book = w.survival.actionLedger.player;
  assert.equal(book.sync, 1, '同步单独计数');
  assert.equal(sum(book.attempt), before, '不得进 attempt');
  assert.equal(book.laborAttempt ?? 0, 0, '同步不是劳动');
});

test('E2-02 玩家与居民同一口径：attempt/success/minutes/energy/labor 都入账', () => {
  const sp = make(), w = sp.world;
  w.t = 10;
  move(w, 'p1', 'yard');
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  const p = w.survival.actionLedger.player;
  assert.equal(p.attempt.gather, 1);
  assert.equal(p.success.gather, 1);
  assert.equal(p.laborAttempt, 1);
  assert.ok(p.minutes.gather > 0, '玩家动作时间要入账');
  const a = w.agents.a1;
  move(w, 'a1', 'yard');
  a.drives.v.energy = 0.5;
  a.execute(w, { id: 'gather', kind: 'gather' }, 'deliberation', w.t, true);
  const r = w.survival.actionLedger.resident;
  assert.equal(r.attempt.gather, 1);
  assert.equal(r.laborAttempt, 1);
  assert.ok(r.minutes.gather > 0 && r.energy.gather > 0, '居民动作的时间与体力都要入账');
  assert.ok(r.byLayer['gather:deliberation'] >= 1, '决策来源保留');
  const dump = dumpSurv(sp);
  assert.ok(dump.survival.actionLedger.player.minutes.gather > 0, '累计账本要随档');
});

test('E2-03 拒绝与中止分开记：规则拒绝进 refused，进行中被打断进 aborted', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'yard');
  a.drives.v.energy = 0.001;
  a.execute(w, { id: 'gather', kind: 'gather' }, 'deliberation', w.t, true);
  assert.equal(w.survival.actionLedger.resident.refused.gather, 1, '体力门属拒绝');
  // 进行中动作：体力见底 ⇒ 中止
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  const clock = clockOf(w, 'a1');
  clock.tick = { t: w.t, usedMin: 55, n: 1 };
  assert.equal(a.execute(w, { id: 'build', kind: 'build' }, 'deliberation', w.t, true).code, 'BUSY_START');
  a.drives.v.energy = 0;
  assert.equal(advanceResidentBusy(w, 'a1').code, 'STAMINA');
  assert.equal(w.survival.actionLedger.resident.aborted.build, 1, '中止单独记，不和拒绝混');
});

test('E2-04 长跑报表用累计账本（正式游戏）', async () => {
  const r = await runLong(7, 30, { options: FORMAL_OPTIONS });
  const stats = r.final.stats;
  assert.ok(stats, '长期报告必须带账本读数');
  for (const side of ['player', 'resident']) {
    assert.ok(stats[side], `${side} 应有账本读数`);
    assert.ok(stats[side].laborRate === null || (stats[side].laborRate >= 0 && stats[side].laborRate <= 1), `${side} 劳动成功率必须在 [0,1]`);
  }
  // 长跑夹具里玩家开局闲置，玩家侧可以是 0；居民侧必须真的在劳动。
  assert.ok(stats.resident.attempt > 0, '居民应有行动记录');
  assert.ok(stats.resident.minutes > 0, '居民劳动时间应可累计');
  assert.ok(stats.resident.attempt >= stats.resident.success, '成功不可能多于尝试');
});

test('E2-05 研究态保持旧账本形状（逐位不变边界）', () => {
  const sp = createSurvPlay(7, { independentWorld: true, unifiedCooperation: true }), w = sp.world;
  w.t = 10;
  move(w, 'a1', 'home');
  w.agents.a1.execute(w, { kind: 'rest' }, 'deliberation', w.t, true);
  const book = w.survival.actionLedger.resident;
  assert.equal(Object.hasOwn(book, 'minutes'), false, '研究态不写 minutes');
  assert.equal(Object.hasOwn(book, 'laborAttempt'), false, '研究态不写 labor 计数');
});

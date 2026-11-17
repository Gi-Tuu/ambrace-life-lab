// V7.3 第二批闸门：共享成本表、玩家 60 分/刻池、跨刻 busy、体力/viab 分离、同刻移动、旧档恢复、研究态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, playerReach, playerTimeLeft, survAct, tickSurvPlay } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { costFor } from './action-cost.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const make = (seed = 7) => createSurvPlay(seed, GAME);
const gatherWorld = () => {
  const sp = make(), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard');
  w.survival.resStock.yard = 500;
  return sp;
};

test('V73-01 同刻 6 个 10 分钟动作全成，第 7 个 TIME_WAIT（不再按日账）', () => {
  const sp = gatherWorld(), w = sp.world;
  for (let i = 0; i < 6; i += 1) {
    const r = survAct(sp, { kind: 'gather' });
    assert.ok(r.ok, `第 ${i + 1} 个采集应成功：${JSON.stringify(r)}`);
  }
  assert.equal(w.t, 10, '玩家动作不得推进世界刻');
  const r = survAct(sp, { kind: 'gather' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIME_WAIT', JSON.stringify(r));
});

test('V73-02 30 分钟动作拆 5+25：busy 跨刻，总体力与一次 30 分钟相同', async () => {
  const sp = make(), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  w.survival.lastDay = Math.floor(w.t / 24); // 不让首次 tick 触发日界配给（那会回 0.5 体力，干扰成本测量）
  const clock = clockOf(w, 'p1');
  clock.tick = { t: w.t, usedMin: 55, n: 0 }; // 本刻只剩 5 分钟
  const before = w.agents.p1.drives.v.energy;
  const start = survAct(sp, { kind: 'build' });
  assert.equal(start.code, 'BUSY_START', JSON.stringify(start));
  assert.equal(w.survival.sites[0].progress, 0, '未完成前不得先结算效果');
  const left = playerTimeLeft(w);
  assert.ok(left >= 0 && left <= 5.0001, `本刻剩余应≤5，实测 ${left}`);
  await tickSurvPlay(sp); // 下一克推进 25 分钟并完成
  // 用累计账本量动作体力（tick 里还有基础代谢 0.012，不能拿原始差值当动作成本）
  const book = w.survival.actionLedger.player;
  assert.ok(Math.abs(book.energy.build - 0.10) < 1e-9, `5+25 动作体力应=0.10，实测 ${book.energy.build}`);
  assert.ok(Math.abs(book.minutes.build - 30) < 1e-9, `动作分钟应=30，实测 ${book.minutes.build}`);
  assert.ok(w.survival.sites[0].progress > 0, '跨刻完成后应落施工进度');
  const events=(w.survival.eventJournal?.rows??[]).filter((e)=>e.kind==='player_action');
  assert.equal(events.length,1,'进行中动作完成应只写一条聚落事件');
  assert.equal(events[0].status,'completed');
  assert.equal(events[0].minutes,30);
});

test('V73-07 busy 中止写账本+事件，且同一动作只结算一次', async () => {
  const sp = make(), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  w.survival.lastDay = Math.floor(w.t / 24);
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  w.survival.sites = []; // 目标失效
  await tickSurvPlay(sp);
  const events = () => (w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action');
  assert.equal(events().length, 1, '中止也要写事件');
  assert.equal(events()[0].status, 'aborted');
  assert.ok((w.survival.actionLedger.player.attempt.build ?? 0) >= 1, '中止进累计账本');
  await tickSurvPlay(sp);
  assert.equal(events().length, 1, '同一 action id 只结算一次');
});

test('V73-03 玩家与居民同一动作共享同一分钟/体力表', () => {
  const player = costFor('gather');
  assert.equal(player.minutes, 10);
  assert.equal(player.energy, 0.03);
  const sp = gatherWorld(), w = sp.world;
  const e0 = w.agents.p1.drives.v.energy;
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  assert.ok(Math.abs((e0 - w.agents.p1.drives.v.energy) - 0.03) < 1e-9, '玩家采集应扣 0.03 体力');
  move(w, 'a1', 'yard');
  w.agents.a1.drives.v.energy = 0.5;
  const e1 = w.agents.a1.drives.v.energy;
  const r = w.agents.a1.execute(w, { kind: 'gather' }, 'deliberation', w.t, true);
  assert.ok(r?.ok);
  assert.ok(Math.abs((e1 - w.agents.a1.drives.v.energy) - 0.03) < 1e-9, '居民采集也应扣 0.03');
});

test('V73-04 同刻连续移动不再被 TELEPORT，超速仍拒', () => {
  const sp = make(), w = sp.world;
  w.t = 10; w.loc.p1 = 'yard';
  const base = [22, 24];
  w.survival.playerPos = { x: base[0], z: base[1], t: w.t };
  assert.ok(playerReach(w, [base[0] + 5, base[1]]).ok, '同刻第一步应放行');
  assert.ok(playerReach(w, [base[0] + 9, base[1]]).ok, '同刻第二步仍应放行（总位移≤10）');
  assert.equal(playerReach(w, [base[0] + 60, base[1]]).code, 'TELEPORT', '超速仍拒');
});

test('V73-05 旧档恢复：busy 与已扣体力不重复结算', () => {
  const sp = make(), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  const energy = w.agents.p1.drives.v.energy;
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME).world;
  assert.ok(back.survival.actClock.p1.busy, 'busy 必须随档恢复');
  assert.ok(Math.abs(back.agents.p1.drives.v.energy - energy) < 1e-9, '载入不得重复扣体力');
});

test('V73-06 研究态仍走旧路径（不建共享账），第二次同刻动作被拒', () => {
  const sp = createSurvPlay(7, { unifiedCooperation: true }), w = sp.world;
  w.t = 10; move(w, 'a1', 'home');
  assert.equal(w.survival.actTimeModel, undefined);
  assert.ok(w.agents.a1.execute(w, { kind: 'rest' }, 'deliberation', w.t, true).ok);
  assert.equal(w.agents.a1.execute(w, { kind: 'rest' }, 'deliberation', w.t, true), null);
  assert.equal(w.survival.resLedger, undefined, '研究态不建共享资源账');
});





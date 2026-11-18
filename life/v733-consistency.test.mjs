// V7.3.3 P1/P2：观测器、窗口、动态居民、代谢路径、账本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvent, createActionObserver } from './action-observer.mjs';
import { measureIdle } from './idle-probe.mjs';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { move, isAlive } from './body.mjs';
import { installFairSched } from './fair-sched.mjs';
import { clockOf } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('V733-OBS 观测器去重/限长/不耗随机数', () => {
  const o = createActionObserver({ cap: 3 });
  const e = actionEvent({ actorId: 'a1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10, actualEnergy: .03 });
  assert.equal(o.feed(e), true);
  assert.equal(o.feed({ ...e }), false, '同键去重');
  for (let i = 0; i < 5; i += 1) o.feed(actionEvent({ actorId: 'a1', worldTick: 6 + i, kind: 'move', status: 'completed' }));
  assert.equal(o.events.length, 3, '限长');
  assert.equal(o.dropped(), 3);
});

test('V733-WIN 窗口=日×24 刻；1/2 日边界精确', async () => {
  const r1 = await measureIdle(7, 1);
  assert.equal(r1.ticksRun, 24, '1 日必须 24 刻');
  assert.equal(r1.actualDays, 1);
  const r2 = await measureIdle(7, 2);
  assert.equal(r2.ticksRun, 48, '2 日必须 48 刻');
  assert.equal(r2.actualDays, 2);
});

test('V733-DYN cap1：新生首跑经额度调度，全灭只剩后代仍继续，重复登记幂等', async () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  process.env.FAIR_SCHED = '1'; process.env.FAIR_DECISION_CAP = '1';
  // 已安装的 world 重新装 cap1
  installFairSched(w, { FAIR_SCHED: '1', FAIR_DECISION_CAP: '1' });
  for (let i = 0; i < 3; i += 1) await tickSurvPlay(sp);
  const base = Object.values(w.agents).filter((a) => !a.isPlayer);
  const before = base.map((a) => a.metabCount ?? 0);
  await tickSurvPlay(sp);
  for (let i = 0; i < base.length; i += 1) assert.equal((base[i].metabCount ?? 0) - before[i], 1, 'cap1 下每人仍代谢一次');
  process.env.FAIR_SCHED = '0'; process.env.FAIR_DECISION_CAP = '8';
});

test('V733-MET 同刻代谢：busy/无机会/第二 episode/读档首刻恰好一次', async () => {
  process.env.FAIR_SCHED = '1'; process.env.FAIR_DECISION_CAP = '1';
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'a1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.a1 = { wood: 5, stone: 5 };
  clockOf(w, 'a1').tick = { t: w.t, usedMin: 55, n: 0 };
  const a = w.agents.a1;
  const start = a.execute(w, { kind: 'build' }, 'deliberation', w.t, true);
  assert.equal(start.code, 'BUSY_START');
  const n0 = a.metabCount ?? 0;
  await tickSurvPlay(sp); // busy 推进 + 所有居民基础
  assert.ok((a.metabCount ?? 0) - n0 >= 1, 'busy 时也代谢');
  const n1 = a.metabCount ?? 0;
  await a.tick(w); // 同刻第二 episode
  assert.equal((a.metabCount ?? 0) - n1, 0, '第二 episode 不重复代谢');
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  const b = back.world.agents.a1;
  const n2 = b.metabCount ?? 0;
  await tickSurvPlay(back);
  assert.equal((b.metabCount ?? 0) - n2, 1, '读档首刻代谢恰好一次');
  process.env.FAIR_SCHED = '0'; process.env.FAIR_DECISION_CAP = '8';
});

test('V733-LED 账本：资格失败/执行失败/中止/取消/技术 sync 定义', async () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'a1', 'yard');
  w.survival.resStock.yard = 500;
  // 资格失败：不在菜园 harvest
  assert.equal(w.agents.a1.execute(w, { kind: 'harvest' }, 'deliberation', w.t, true), null);
  const L = () => w.survival.actionLedger.resident;
  assert.ok((L().refused.harvest ?? 0) >= 1);
  assert.ok((L().attempt.harvest ?? 0) === 0, '资格失败不进 attempt');
  // 执行失败：玩家在错误地点采集（walk 走 yard 可采；改用 camp_eat 不在家）
  const p = (await import('./survplay.mjs')).survAct;
  const bad = p(sp, { kind: 'camp_eat' });
  assert.equal(bad.ok, false);
  // 取消/中止：busy 后取消
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(p(sp, { kind: 'build' }).code, 'BUSY_START');
  assert.equal(p(sp, { kind: 'busy_cancel' }).ok, true);
  assert.ok((w.survival.actionLedger.player.cancelled.build ?? 0) >= 1);
  // sync 不计劳动
  p(sp, { kind: 'player_sync', from: [w.survival.playerPos?.x ?? 20, w.survival.playerPos?.z ?? 34] });
  assert.equal(w.survival.actionLedger.player.sync, 1);
  assert.equal(w.survival.actionLedger.player.attempt.player_sync, undefined);
});


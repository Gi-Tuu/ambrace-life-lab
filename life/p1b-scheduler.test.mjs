// P1b 闸门：1 游戏分钟调度真正接进世界推进（动作/think 分钟级；世界重结算仍按 60 分）。
// 先写红：实现前这些断言必须失败；实现后逐条变绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, tickSurvPlay, simMinuteCursor, resetSimMinuteCursor, awaitSurvivalThinks } from './survplay.mjs';
import { createSimClock } from './sim-clock.mjs';
import { createSimScheduler, gameMinutesForRealMinutes } from './sim-scheduler.mjs';
import { move } from './body.mjs';
import { Organism } from './agent.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
  playerRation: true,
};

function makeGame(seed = 7, rate = 1) {
  let nowMs = 0;
  const clock = createSimClock({ now: () => nowMs, tickMs: 7500, rate, manual: true });
  const sp = createSurvPlay(seed, { ...GAME, simTime: true, simClock: clock });
  resetSimMinuteCursor(sp.world);
  return {
    sp, clock,
    at(minutes) {
      clock.setGameMinutes(minutes);
      sp.world.t = Math.floor(minutes / 60);
      resetSimMinuteCursor(sp.world);
      return sp.world;
    },
    advance(minutes) { clock.advanceMinutes(minutes); },
  };
}

function startPlayerBuild(sp, atMin = 600) {
  const w = sp.world;
  move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  w.survival.lastDay = Math.floor(atMin / 1440);
  const r = survAct(sp, { kind: 'build' });
  assert.equal(r.code, 'BUSY_START', JSON.stringify(r));
  return r;
}

test('P1b-01 tickSurvPlay({minutes:1}) 只推进 1 游戏分钟，不再有 60 分保底', async () => {
  const { sp, clock, at } = makeGame();
  const w = at(600);
  for (const a of Object.values(w.agents)) a.nextThinkMin = 1e9; // 本闸门只看时间，不让 think 抢戏
  assert.equal(simMinuteCursor(w), 600);
  await tickSurvPlay(sp, { minutes: 1 });
  assert.ok(Math.abs(clock.nowMinutes() - 601) < 1e-9, `clock 应为 601，实测 ${clock.nowMinutes()}`);
  assert.equal(w.t, 10, '仍在第 10 刻内');
  assert.equal(simMinuteCursor(w), 601, '已消费游标必须只走 1 分钟');
});

test('P1b-02 30 分动作在 endMin=630 完成，不依赖 60 分 tick 边界', async () => {
  const { sp, clock, at } = makeGame();
  const w = at(600);
  for (const a of Object.values(w.agents)) a.nextThinkMin = 1e9;
  const r = startPlayerBuild(sp, 600);
  assert.equal(r.endMin, 630);
  for (let m = 601; m <= 629; m += 1) {
    await tickSurvPlay(sp, { minutes: 1 });
    assert.ok(w.survival.actClock.p1.busy, `${m}: 未到 endMin 前 busy 不得提前清空`);
    assert.equal(w.survival.sites[0].progress, 0, `${m}: 未到 endMin 前不得先结算效果`);
  }
  assert.ok(Math.abs(clock.nowMinutes() - 629) < 1e-9);
  await tickSurvPlay(sp, { minutes: 1 }); // 630
  assert.equal(w.survival.actClock.p1.busy, null, '到 endMin 当分钟结算');
  assert.ok(w.survival.sites[0].progress > 0);
  assert.equal(w.t, 10, '完成点仍落在同一刻内');
  assert.ok(Math.abs(clock.nowMinutes() - 630) < 1e-9);
});

test('P1b-03 同一 tick 内动作完成与 think 到期交错发生', async () => {
  const { sp, clock, at } = makeGame(13);
  const w = at(600);
  const a1 = w.agents.a1, a2 = w.agents.a2;
  move(w, 'a1', 'yard');
  move(w, 'a2', 'hall');
  w.survival.lastDay = 0;
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.a1 = { wood: 5, stone: 5 };
  a1.drives.v.energy = 0.8;
  const started = a1.execute(w, { id: 'build', kind: 'build' }, 'deliberation', w.t, true);
  assert.equal(started.code, 'BUSY_START', JSON.stringify(started));
  a1.nextThinkMin = 605;
  a2.nextThinkMin = 610;
  const before1 = a1.trace.length, before2 = a2.trace.length;
  await tickSurvPlay(sp, { minutes: 30 }); // 600 → 630，一刻之内
  await awaitSurvivalThinks(sp);
  assert.ok(Math.abs(clock.nowMinutes() - 630) < 1e-9);
  assert.equal(w.t, 10, 't 仍是同一刻');
  assert.equal(w.survival.actClock.a1.busy, null, '居民 30 分动作也在分钟级完成');
  const fresh1 = a1.trace.slice(before1), fresh2 = a2.trace.slice(before2);
  assert.ok(fresh1.length > 0, 'a1 在 busy 期间必须留下感知/决策 trace');
  assert.ok(fresh1.some((r) => r.code === 'BUSY'), `a1 应有 BUSY 拒绝 trace：${JSON.stringify(fresh1)}`);
  assert.ok(fresh2.length > 0, 'a2 的 10 分 think 必须在同一 tick 内发生');
  assert.ok([...fresh1, ...fresh2].every((r) => r.t === 10), '同一 tick 内 trace 的 t 都是 10');
});

test('P1b-04 异步模型等待不阻塞 tick 返回，也不串行堵住其他居民', async () => {
  const { sp, at } = makeGame(17);
  const w = at(600);
  const a1 = w.agents.a1, a2 = w.agents.a2;
  a1.nextThinkMin = 601;
  a2.nextThinkMin = 601;
  const original = Organism.prototype.tick;
  const slow = async function slowTick(world) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return original.call(this, world);
  };
  Organism.prototype.tick = slow;
  try {
    const started = Date.now();
    await tickSurvPlay(sp, { minutes: 10 });
    const tickMs = Date.now() - started;
    assert.ok(tickMs < 150, `tick 被模型等待阻塞：${tickMs}ms`);
    // 两个居民都应已派发（in-flight 守卫在各自 agent 上），而不是排在 a1 后面。
    assert.ok(a1.simThinkPromise, 'a1 think 应已派发');
    assert.ok(a2.simThinkPromise, 'a2 think 不应等 a1 的模型返回才派发');
    await new Promise((resolve) => setTimeout(resolve, 380));
    await awaitSurvivalThinks(sp);
  } finally {
    Organism.prototype.tick = original;
  }
});

test('P1b-05 125ms 假时钟：30 分动作在第 30 步（3.75s）完成，不等第 60 步 7.5s', async () => {
  let nowMs = 0;
  const clock = createSimClock({ now: () => nowMs, tickMs: 7500, manual: false });
  const sp = createSurvPlay(23, { ...GAME, simTime: true, simClock: clock });
  clock.setGameMinutes(600);
  sp.world.t = 10;
  resetSimMinuteCursor(sp.world);
  for (const a of Object.values(sp.world.agents)) a.nextThinkMin = 1e9;
  startPlayerBuild(sp, 600);
  const scheduler = createSimScheduler({ clock, cursor: () => simMinuteCursor(sp.world) });
  let completedAtStep = null;
  for (let step = 1; step <= 60; step += 1) {
    nowMs += 125;
    const due = scheduler.peek(nowMs);
    if (due.minutes > 0) await tickSurvPlay(sp); // 调度器只叫醒；欠账由时钟 elapsed 决定
    if (!sp.world.survival.actClock.p1.busy && completedAtStep === null) completedAtStep = step;
  }
  assert.equal(completedAtStep, 30, `30 分动作应在第 30 个 125ms 步完成，实测第 ${completedAtStep} 步`);
  assert.ok(Math.abs(clock.nowMinutes() - 660) < 1e-9, `60 步后应是 660 分，实测 ${clock.nowMinutes()}`);
});

test('P1b-06 离线补时与在线同 rate；cap 仍按旧刻换算成游戏分钟', () => {
  let nowMs = 0;
  const clock = createSimClock({ now: () => nowMs, tickMs: 7500, rate: 2, manual: false });
  assert.equal(gameMinutesForRealMinutes(1, clock), 960, 'rate=2 时 1 真实分=960 游戏分');
  nowMs += 60_000;
  assert.ok(Math.abs(clock.nowMinutes() - 960) < 1e-6, '在线 elapsed 与离线换算必须同 rate');
});

test('P1b-08 居民 think 硬并发上限 2：第 3 个到期者排队，不无限发 Promise', async () => {
  const { sp, at } = makeGame(29);
  const w = at(600);
  for (const id of ['a1', 'a2', 'a3']) w.agents[id].nextThinkMin = 601;
  const original = Organism.prototype.tick;
  let active = 0, peak = 0;
  Organism.prototype.tick = async function slowTick(world) {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 120));
    try { return await original.call(this, world); } finally { active -= 1; }
  };
  try {
    await tickSurvPlay(sp, { minutes: 1 });
    assert.equal(w.think.inFlight, 2, '第 1 分钟只允许 2 个在途模型调用');
    assert.equal(w.think.queue.length, 1, '第 3 个到期者必须排队，而不是同时发 3 个 Promise');
    assert.equal(w.agents.a3.simThinkPending, true);
    await new Promise((resolve) => setTimeout(resolve, 160));
    await awaitSurvivalThinks(sp);
    assert.ok(peak <= 2, `峰值并发 ${peak} 超过硬上限 2`);
    assert.equal(w.think.queue.length, 0, '队列必须被排空');
  } finally {
    Organism.prototype.tick = original;
  }
});

test('P1b-07 旧档重锚：缺 clock 的档按 t*60 接上，首个 1 分钟 tick 不跳', async () => {
  const { sp } = makeGame();
  const raw = structuredClone(dumpSurv(sp));
  raw.t = 10;
  delete raw.clock;
  const back = loadSurv(raw, 7, { ...GAME, simTime: true });
  assert.equal(back.world.simClock.nowTick(), 10);
  const cursor0 = simMinuteCursor(back.world);
  assert.equal(cursor0, 600, '旧档按 t*60 接上游标');
  for (const a of Object.values(back.world.agents)) a.nextThinkMin = 1e9;
  await tickSurvPlay(back, { minutes: 1 });
  assert.equal(simMinuteCursor(back.world), 601);
  assert.equal(back.world.simClock.nowTick(), 10);
});

// V7.2 阶段 B 第 3 步：居民侧个人时间与进行中动作的行为闸门。
// 规则：60 分/刻、1440 分/日；同刻可连续动作但有硬上限；同一角色只有一个进行中动作；
// 施工打断后已完成进度保留；普通劳动扣体力；休息恢复体力；研究态仍走旧的"每刻一次"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf, advanceResidentBusy, TICK_MINUTES, TICK_ACTION_CAP, RESIDENT_MIN } from './resident-time.mjs';

const GAME = {
  residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true,
  wildFood: true, autonomousGoals: true, farmLife: true, settlementLife: true, regionalWork: true,
  playerRation: true, gameRules: true,
};
const make = (seed = 7) => createSurvPlay(seed, GAME);
const lastRefusal = (a) => a.trace.findLast((r) => r.layer === 'refused');
const site = (w, progress = 0) => {
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress }];
  return w.survival.sites[0];
};

test('R1 同一刻在个人时间预算内可连续动作，动作数有硬上限', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'home');
  const rest = { kind: 'rest' };
  const results = [];
  for (let i = 0; i < TICK_ACTION_CAP; i += 1) results.push(a.execute(w, rest, 'deliberation', w.t, true));
  assert.equal(results.filter((r) => r && r.ok).length, TICK_ACTION_CAP, JSON.stringify(results));
  const clock = clockOf(w, 'a1');
  assert.equal(clock.tick.usedMin, TICK_ACTION_CAP * RESIDENT_MIN.rest);
  assert.equal(clock.usedMin, TICK_ACTION_CAP * RESIDENT_MIN.rest, '当天累计分钟要跟着涨');
  // 第 5 个动作：本刻动作数到顶，且不再有"每刻一次"这种永久限制
  assert.equal(a.execute(w, rest, 'deliberation', w.t, true), null);
  assert.equal(lastRefusal(a).code, 'TICK_CAP');
  // 下一世界刻重置本刻预算，但当天累计不重置
  w.t += 1;
  assert.ok(a.execute(w, rest, 'deliberation', w.t, true).ok);
  assert.equal(clockOf(w, 'a1').tick.usedMin, RESIDENT_MIN.rest);
  assert.equal(clockOf(w, 'a1').usedMin, TICK_ACTION_CAP * RESIDENT_MIN.rest + RESIDENT_MIN.rest);
});

test('R2 常规决策环同一世界刻会产生不止一个动作（不是"每刻一次"）', async () => {
  const sp = make(13), w = sp.world, a = w.agents.a1;
  let chained = false;
  for (let i = 0; i < 24 && !chained; i += 1) {
    const before = a.counters.actions;
    await tickSurvPlay(sp);
    const delta = a.counters.actions - before;
    assert.ok(delta <= 1 + 2, `追加决策必须有上限，实测 ${delta}`);
    if (delta >= 2) chained = true;
  }
  assert.ok(chained, '常规决策环应出现"同一刻不止一个动作"');
  const clock = clockOf(w, 'a1');
  assert.ok(clock.tick.usedMin <= TICK_MINUTES, `本刻分钟不得超 60，实测 ${clock.tick.usedMin}`);
});

test('R3 同一角色同一时刻只有一个进行中动作：不能再开第二处施工', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'yard');
  const s = site(w, 0);
  const clock = clockOf(w, 'a1');
  // 本刻只剩 10 分钟，30 分钟的施工装不下 ⇒ 转成进行中动作
  clock.tick = { t: w.t, usedMin: TICK_MINUTES - 10, n: 1 };
  const build = { id: 'build', kind: 'build' };
  const r1 = a.execute(w, build, 'deliberation', w.t, true);
  assert.equal(r1.code, 'BUSY_START', JSON.stringify(r1));
  assert.ok(clock.busy, '应记下进行中的施工');
  assert.equal(clock.busy.remainMin, RESIDENT_MIN.build - 10);
  assert.equal(s.progress, 0, '还没装下的部分不能先产生效果');
  // 同一时刻再开另一处施工 ⇒ 被 busy 挡住
  assert.equal(a.execute(w, { ...build, target: 'other' }, 'deliberation', w.t, true), null);
  assert.equal(lastRefusal(a).code, 'BUSY');
});

test('R4 施工被打断：已完成的进度留在工地，材料不重复扣，busy 清空并留中止记录', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'yard');
  const s = site(w, 2); // 已经有一单位劳动（旧动作的进度）
  const clock = clockOf(w, 'a1');
  const action = { id: 'build', kind: 'build' };
  // 90 分钟的施工进行到一半：已落 1 单位、还剩 60 分钟，下一步会被体力中断
  clock.busy = { kind: 'build', action, startTick: w.t, totalMin: 150, remainMin: 60, progressMin: 90, bankedMin: 90, applied: 3 };
  const inv = JSON.stringify([w.survival.inv, w.pinv?.a1]);
  const done = advanceResidentBusy(w, 'a1');
  assert.equal(done.completed, true, JSON.stringify(done));
  const applied = s.progress;
  assert.ok(applied > 2, `施工应真的落进度，实测 ${applied}`);
  assert.equal(JSON.stringify([w.survival.inv, w.pinv?.a1]), inv, '施工不得重复扣材料');
  // 再造一个进行中的施工，体力见底 ⇒ 中止；已完成的部分不能抹掉
  clock.busy = { kind: 'build', action, startTick: w.t + 1, totalMin: 120, remainMin: 90, progressMin: 30, bankedMin: 30, applied: 1 };
  a.drives.v.energy = 0;
  const aborted = advanceResidentBusy(w, 'a1');
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.code, 'STAMINA');
  assert.equal(clock.busy, null, '中止后必须释放唯一的动作槽');
  assert.equal(s.progress, applied, '打断不得抹掉已经落账的施工进度');
  assert.equal(clock.lastAbort.code, 'STAMINA');
  assert.ok(clock.lastAbort.progressMin >= 30);
});

test('R5 体力门：体力不够连开工都不行，且不白扣个人时间', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'yard');
  const before = clockOf(w, 'a1').usedMin;
  a.drives.v.energy = 0.001;
  const r = a.execute(w, { id: 'gather', kind: 'gather' }, 'deliberation', w.t, true);
  assert.equal(r, null);
  assert.equal(lastRefusal(a).code, 'STAMINA');
  assert.equal(clockOf(w, 'a1').usedMin, before, '被体力拒绝的动作不得吃掉个人时间');
  // 体力够了，同样的动作就能做成，并且扣的是体力
  a.drives.v.energy = 0.5;
  const ok = a.execute(w, { id: 'gather', kind: 'gather' }, 'deliberation', w.t, true);
  assert.ok(ok?.ok, JSON.stringify(ok));
  assert.ok(a.drives.v.energy < 0.5, '普通劳动应从体力里扣');
});

test('R6 休息恢复体力（个人时间模型下体力才是短期劳动账户）', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', w.housing.a1);
  a.drives.v.energy = 0.2;
  const r = a.execute(w, { id: 'rest', kind: 'rest' }, 'deliberation', w.t, true);
  assert.ok(r?.ok, JSON.stringify(r));
  assert.ok(a.drives.v.energy > 0.2, `休息后体力应回升，实测 ${a.drives.v.energy}`);
});

test('R8 旧档 actClock 缺 busy/tick 字段：载入后按当前刻补账，不拒绝', async () => {
  const sp = make(), w = sp.world;
  const raw = structuredClone(dumpSurv(sp));
  raw.survival.actClock.a1 = { day: 0, usedMin: 90 }; // 第 1 步留下的旧字段
  const back = loadSurv(raw, 7, GAME);
  const clock = back.world.survival.actClock.a1;
  assert.equal(clock.usedMin, 90, '旧账要继续有效');
  await tickSurvPlay(back);
  const after = back.world.survival.actClock.a1;
  assert.equal(after.tick.t, back.world.t, '本刻预算应补齐');
  assert.ok(Number.isFinite(after.usedMin));
});

test('R9 进行中的动作随存档恢复：busy 与 remainMin 不丢', () => {
  const sp = make(), w = sp.world, a = w.agents.a1;
  w.t = 10;
  move(w, 'a1', 'yard');
  site(w, 0);
  const clock = clockOf(w, 'a1');
  clock.tick = { t: w.t, usedMin: TICK_MINUTES - 5, n: 1 };
  const r = a.execute(w, { id: 'build', kind: 'build' }, 'deliberation', w.t, true);
  assert.equal(r.code, 'BUSY_START');
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  const busy = back.world.survival.actClock.a1.busy;
  assert.equal(busy.kind, 'build');
  assert.equal(busy.remainMin, RESIDENT_MIN.build - 5);
});

test('R7 研究态保持旧的"每刻一次"：不建 actClock，第二次执行仍被拒', () => {
  const sp = createSurvPlay(7, { unifiedCooperation: true }), w = sp.world, a = w.agents.a1;
  w.t = 10;
  assert.equal(w.survival.actModel ?? undefined, undefined);
  assert.equal(w.survival.actClock, undefined, '研究态不得写个人时间账');
  assert.ok(a.execute(w, { kind: 'rest' }, 'deliberation', w.t, true).ok);
  assert.equal(a.execute(w, { kind: 'rest' }, 'deliberation', w.t, true), null);
  assert.equal(w.survival.residentActionsAt.a1, w.t);
});

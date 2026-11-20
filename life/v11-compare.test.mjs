// 1.1 第 3 项闸门：对照模式也走连续时钟/分钟调度。
// 钉住：A/B 各自独立时钟（同起点/同 rate）；单侧暂停/倍速只影响该侧；act/tick 共用短锁；
// 回放按分钟取场景；旧 comparison.json 无 clock/minute 仍可读；A 侧与官方生存同轨迹。
// 1.1 compare 连续收口追加的硬闸门：
//   06 A 逐位=官方、B 逐位=单独跑（1020 分，每小时 dumpSurv）；
//   07 暂停一侧 100 拍、08 倍速一侧 100 拍，另一侧仍逐位=单独跑（锚定不累计漂移）；
//   09 act 在主 tick 在途时可返回，A/B 各写各的、不交叉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'v11-compare-'));
process.env.SEED_FILE = join(process.env.DATA_DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.TICK_MS = '1000000';
process.env.SAVE_EVERY = '1000000';
process.env.ACT_SAVE_COALESCE_MS = '1000000';
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.MODEL_UNATTENDED = '0';
// 寻路预算是真实毫秒额度（默认 120ms/世界/刻）：机器负载高时同一输入会少算出一条路线，
// 逐位闸门会因此假红。本文件测的是“调度是否让两侧同步”，不是“A* 在 120ms 内算完”，
// 所以把额度放大到实际不会触发；产品默认值不改。
process.env.P2C_ROUTE_BUDGET_MS = '100000';

const { host, flushWrites, survivalOptions } = await import('./host.mjs');
const { createSimClock } = await import('./sim-clock.mjs');
const { createSimScheduler } = await import('./sim-scheduler.mjs');
const { loadSurv, dumpSurv, tickSurvPlay, resetSimMinuteCursor } = await import('./survplay.mjs');

const stripClock = (world) => {
  const copy = structuredClone(world);
  delete copy.clock;
  return copy;
};
// 世界事实逐位比较：排除 `clock`（rate/paused/gameMinutes 是时钟读法，各侧可独立，
// 存在/空值也按存档 JSON 口径归一），其余（含派生 t、weather、log、settlementEvents）必须逐位相同。
const stableDump = (dump) => {
  const copy = JSON.parse(JSON.stringify(dump));
  delete copy.clock;
  return copy;
};
const compareMasksFor = (masks) => ({
  A: Object.fromEntries(Object.entries(masks ?? {}).filter(([k, on]) => on && k !== 'm3').map(([k]) => [k, 1])),
  B: { m3: 0, coupling: 0 },
});
// 逐位断言失败时给出第一条差异路径（比整棵 deepStrictEqual 的 diff 更好定位）。
const firstDiff = (a, b, path = '') => {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return path || '(root)';
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDiff(a[key], b[key], path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
};
const assertSameWorld = (actual, expected, label) => {
  assert.equal(firstDiff(actual, expected), null, `${label}：第一处差异 ${firstDiff(actual, expected)}`);
  assert.deepEqual(actual, expected, label);
};
// “单独跑”的参考世界：与 makeComparison 用的是同一套构造参数（同一 origin/条件/通道掩码），
// 但只推进自己的分钟，不经过 compare 锁、不受另一侧 pause/rate 影响。
function makeReference(origin, side, masks) {
  const clock = createSimClock({ rate: 1 });
  const sp = loadSurv(structuredClone(origin), 7, {
    ...survivalOptions(), simTime: true, simClock: clock,
    residentCondition: side === 'A' ? 'C2' : 'C2-neg',
    residentChannelMask: compareMasksFor(masks)[side], deliberator: null,
  });
  sp.world.simClock.setGameMinutes(Math.max(0, Number(origin?.t ?? 0)) * 60);
  resetSimMinuteCursor(sp.world);
  return sp;
}
const readJson = (name) => JSON.parse(readFileSync(join(process.env.DATA_DIR, name), 'utf8'));

async function freshCompare() {
  assert.equal((await host.ctl({ action: 'reset', confirm: true })).ok, true);
  const started = await host.ctl({ mode: 'compare', action: 'compare_reset', confirm: true, fromSurvival: true });
  assert.equal(started.ok, true, JSON.stringify(started));
  const pair = host.snapshot('compare').comparison;
  assert.ok(pair, '对照世界必须存在');
  return pair;
}
async function stepBoth(times = 1) {
  for (let i = 0; i < times; i += 1) {
    assert.equal((await host.ctl({ action: 'step' })).ok, true);
    assert.equal((await host.ctl({ mode: 'compare', action: 'step' })).ok, true);
  }
}

test('V11-CMP-01 正式态 A/B 同起点独立时钟；A 轨迹=官方生存，B 分叉', async (t) => {
  await host.start();
  t.after(() => host.stop());
  let pair = await freshCompare();
  assert.ok(pair.A.clock && pair.B.clock, '正式态 compare 必须带连续时钟');
  assert.equal(pair.A.clock.rate, 1);
  assert.equal(pair.B.clock.rate, 1);
  assert.ok(Math.abs(pair.A.clock.gameMinutes - pair.B.clock.gameMinutes) < 0.1, 'A/B 必须同起点（<0.1 游戏分）');
  assert.equal(pair.A.t, pair.startTick);
  assert.equal(pair.B.t, pair.startTick);

  await flushWrites();
  const origin = readJson('comparison.json');
  assert.deepEqual(stripClock(origin.branches.A.world), stripClock(origin.branches.B.world), '同起点两侧世界逐位相同');

  await stepBoth(6);
  await flushWrites();
  pair = host.snapshot('compare').comparison;
  const record = readJson('comparison.json');
  const official = readJson('world.json').survival;
  assert.equal(record.branches.A.world.t, official.t);
  assert.equal(record.branches.A.world.t, record.branches.B.world.t);
  assert.deepEqual(stripClock(record.branches.A.world), stripClock(official),
    'A 侧必须与正式生存同起点、同输入、同分钟步的轨迹逐位一致');
  assert.notDeepEqual(record.branches.A.world.survival.aiActions, record.branches.B.world.survival.aiActions,
    'B 侧通道切断必须表现为独立分叉，不能跟着 A 走');
  assert.ok(pair.A.clock !== pair.B.clock, 'A/B 时钟必须是两个独立对象');
  assert.ok(Math.abs(pair.A.clock.gameMinutes - pair.B.clock.gameMinutes) < 0.1);
});

test('V11-CMP-02 单侧暂停只冻结该侧；全局 pause 仍可手动 60 分 step', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  await host.ctl({ mode: 'compare', action: 'step' });
  let pair = host.snapshot('compare').comparison;
  const startA = pair.A.t, startB = pair.B.t;

  const paused = await host.ctl({ mode: 'compare', action: 'pause', side: 'A' });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  pair = host.snapshot('compare').comparison;
  assert.equal(pair.A.clock.paused, true);
  assert.equal(pair.B.clock.paused, false, '暂停 A 不得冻结 B');
  await host.ctl({ mode: 'compare', action: 'step' });
  pair = host.snapshot('compare').comparison;
  assert.equal(pair.A.t, startA, 'A 暂停时不得推进');
  assert.equal(pair.B.t, startB + 1, 'B 必须继续按自己的时钟推进');

  assert.equal((await host.ctl({ mode: 'compare', action: 'resume', side: 'A' })).ok, true);
  pair = host.snapshot('compare').comparison;
  assert.equal(pair.A.clock.paused, false);
  await host.ctl({ mode: 'compare', action: 'step' });
  pair = host.snapshot('compare').comparison;
  assert.equal(pair.A.t, startA + 1, '恢复后 A 继续走');
  assert.equal(pair.B.t, startB + 2);

  // 全局暂停只停自动推进；手动 step 仍是显式 60 分（旧契约）。
  assert.equal((await host.ctl({ mode: 'compare', action: 'pause' })).ok, true);
  assert.equal(host.snapshot('compare').compareRunning, false);
  const before = host.snapshot('compare').comparison;
  await host.ctl({ mode: 'compare', action: 'step' });
  const after = host.snapshot('compare').comparison;
  assert.equal(after.A.t, before.A.t + 1);
  assert.equal(after.B.t, before.B.t + 1);
  assert.equal((await host.ctl({ mode: 'compare', action: 'resume' })).ok, true);
});

test('V11-CMP-03 单侧倍速只改该侧；独立 scheduler 按各自 rate 欠分钟', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  const rate = await host.ctl({ mode: 'compare', action: 'rate', side: 'A', rate: 2 });
  assert.equal(rate.ok, true, JSON.stringify(rate));
  const pair = host.snapshot('compare').comparison;
  assert.equal(pair.A.clock.rate, 2);
  assert.equal(pair.B.clock.rate, 1, 'A 倍速不得改 B');

  // 同一真实 60s：A 欠 2 倍分钟、B 欠 1 倍；两个 scheduler 各自只推进自己的游标。
  let nowMs = 0;
  const clockA = createSimClock({ now: () => nowMs, tickMs: 7500, rate: 2 });
  const clockB = createSimClock({ now: () => nowMs, tickMs: 7500, rate: 1 });
  const schedA = createSimScheduler({ clock: clockA, cursor: () => 0, now: () => nowMs });
  const schedB = createSimScheduler({ clock: clockB, cursor: () => 0, now: () => nowMs });
  nowMs = 30000;
  assert.equal(schedA.peek(nowMs).minutes, 480);
  assert.equal(schedB.peek(nowMs).minutes, 240);
  assert.equal(schedA.peek(nowMs).minutes, schedB.peek(nowMs).minutes * 2);
});

test('V11-CMP-04 回放：tick→分钟取场景，场景与实时一致；旧 archive 可读', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  await stepBoth(3);
  const pair = host.snapshot('compare').comparison;
  const liveA = pair.A, liveB = pair.B;
  const at = liveA.t;
  const replay = host.replay({ t: at, revision: pair.revision });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.frame.minute, at * 60, '新帧必须带分钟真值');
  assert.equal(replay.scenes?.A?.t, at);
  assert.equal(replay.scenes?.B?.t, at);
  for (const [side, live] of [['A', liveA], ['B', liveB]]) {
    const scene = replay.scenes?.[side];
    assert.deepEqual(scene.loc, live.loc, `${side} 场景地点必须与实时一致`);
    assert.deepEqual(scene.occupancy, live.occupancy, `${side} 场景占位必须与实时一致`);
    assert.deepEqual(scene.playerPos, live.playerPos, `${side} 场景玩家位置必须与实时一致`);
    assert.equal(scene.store, live.store);
  }
  assert.equal(host.replay({ t: pair.startTick, revision: pair.revision }).ok, true, '起点帧仍可回放');

  // 旧版 comparison.json：没有 clock / minute / minutes / sceneMinutes，只有 t 和 scene。
  await flushWrites();
  const file = join(process.env.DATA_DIR, 'comparison.json');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  for (const side of ['A', 'B']) {
    delete old.branches[side].world.clock;
    delete old.branches[side].world.weather;
  }
  for (const frame of old.replay.frames ?? []) {
    delete frame.minute;
    delete frame.minutes;
  }
  delete old.replay.sceneMinutes;
  await host.stop();
  writeFileSync(file, JSON.stringify(old));
  await host.start();
  const restored = host.snapshot('compare');
  assert.equal(restored.compareSaveError, null, '旧对照档不得被误判为损坏');
  assert.ok(restored.comparison.A.clock && restored.comparison.B.clock, '旧档读入后按 t*60 接回连续钟');
  assert.equal(restored.comparison.A.t, restored.comparison.B.t);
  assert.equal(restored.comparison.A.t, old.branches.A.world.t);
  const oldReplay = host.replay({ t: old.replay.frames.at(-1).t, revision: restored.comparison.revision });
  assert.equal(oldReplay.ok, true, JSON.stringify(oldReplay));
  assert.ok(oldReplay.scenes, '旧帧 scene 仍应可读（不要求新 sceneMinutes 索引）');
});

test('V11-CMP-05 camp_sleep 在 compare 内走同一把短锁：两侧各推进 ticks×60，不重入死锁', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const pair = await freshCompare();
  const revision = pair.revision;
  // 睡觉要求玩家在家：先走回 home（act 与 tick 共用同一把 compare 锁，不能互相饿死）。
  const moved = await host.act({ mode: 'compare', revision, kind: 'move', room: 'home' });
  assert.equal(moved.sides.A.ok, true, JSON.stringify(moved));
  const before = host.snapshot('compare').comparison;
  const slept = await host.act({ mode: 'compare', revision, kind: 'camp_sleep' });
  assert.equal(slept.ok, true, JSON.stringify(slept));
  assert.ok((slept.ticks ?? 0) > 0, '在家必须能睡至少一刻');
  const after = host.snapshot('compare').comparison;
  // 一次睡眠是短锁内的原子事务：两侧各自按 60 游戏分/刻推进到同一段区间末端。
  assert.equal(after.A.t, before.A.t + slept.ticks, JSON.stringify({ before: before.A.t, after: after.A.t, ticks: slept.ticks }));
  assert.equal(after.B.t, before.B.t + slept.ticks);
  assert.ok(Math.abs(after.A.clock.gameMinutes - after.B.clock.gameMinutes) < 0.5, '睡醒后 A/B 仍在同一分钟量级');
  // 同一条 compareChain 里的第二次睡眠必须排在前一次之后，不能自锁。
  const again = await host.act({ mode: 'compare', revision, kind: 'camp_sleep' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.ok((await host.ctl({ mode: 'compare', action: 'step' })).ok, '睡眠后 compare 仍可手动 step');
});

test('V11-CMP-06 同起点同输入跑 1020 分：A 逐位=官方、B 逐位=单独跑（每小时比 dumpSurv）', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  await flushWrites();
  const base = readJson('comparison.json');
  const origin = base.origin, masks = base.masks ?? {};
  const refB = makeReference(origin, 'B', masks);
  const HOURS = 17; // 17 × 60 = 1020 游戏分 > 1000
  for (let hour = 1; hour <= HOURS; hour += 1) {
    assert.equal((await host.ctl({ action: 'step' })).ok, true);
    assert.equal((await host.ctl({ mode: 'compare', action: 'step' })).ok, true);
    assert.equal(await host.save(), true, '官方世界必须落盘');
    await flushWrites();
    await tickSurvPlay(refB, { minutes: 60 });
    const official = readJson('world.json').survival;
    const record = readJson('comparison.json');
    assert.equal(record.branches.A.world.t, official.t, `第 ${hour} 小时 A/官方的刻必须一致`);
    assert.equal(record.branches.A.world.t, record.branches.B.world.t, `第 ${hour} 小时 A/B 的刻必须一致`);
    // 相位只允许是“同一现实刻读取之间”的亚分钟差；跨整分钟就是调度漂移。
    const minute = (w) => Number(w.clock?.gameMinutes ?? 0);
    assert.ok(Math.abs(minute(record.branches.A.world) - minute(official)) < 0.5,
      `第 ${hour} 小时 A/官方不得差一个整分钟：${minute(record.branches.A.world)} vs ${minute(official)}`);
    assert.ok(Math.abs(minute(record.branches.A.world) - minute(record.branches.B.world)) < 0.5);
    assertSameWorld(stableDump(record.branches.A.world), stableDump(official),
      `第 ${hour} 小时 A 必须逐位等于官方轨迹（只排除 clock.gameMinutes 的真实毫秒读数）`);
    assertSameWorld(stableDump(record.branches.B.world), stableDump(dumpSurv(refB)),
      `第 ${hour} 小时 B 必须逐位等于单独跑的负对照`);
  }
});

test('V11-CMP-07 暂停一侧 100 拍：被暂停侧冻结，另一侧逐位=单独跑（锚定不累计漂移）', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  await flushWrites();
  const base = readJson('comparison.json');
  const origin = base.origin, masks = base.masks ?? {};
  const refB = makeReference(origin, 'B', masks);
  assert.equal((await host.ctl({ mode: 'compare', action: 'pause', side: 'A' })).ok, true);
  const startPair = host.snapshot('compare').comparison;
  let frozenA = null;
  for (let tick = 1; tick <= 100; tick += 1) {
    assert.equal((await host.ctl({ mode: 'compare', action: 'step' })).ok, true);
    await tickSurvPlay(refB, { minutes: 60 });
    const record = readJson('comparison.json');
    const pair = host.snapshot('compare').comparison;
    if (tick === 1) frozenA = stableDump(record.branches.A.world);
    assert.equal(pair.A.t, startPair.A.t, `第 ${tick} 拍暂停侧不得推进`);
    assert.equal(pair.A.clock.paused, true);
    assert.equal(pair.B.t, startPair.B.t + tick, `第 ${tick} 拍 B 必须按自己的钟推进`);
    assert.deepEqual(stableDump(record.branches.A.world), frozenA, `第 ${tick} 拍暂停侧世界不得被另一侧带跑`);
    assertSameWorld(stableDump(record.branches.B.world), stableDump(dumpSurv(refB)),
      `第 ${tick} 拍 B 仍必须逐位等于单独跑（锚定不得累计漂移）`);
  }
});

test('V11-CMP-08 倍速一侧 100 拍：两侧轨迹仍逐位=各自单独跑', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await freshCompare();
  await flushWrites();
  const base = readJson('comparison.json');
  const origin = base.origin, masks = base.masks ?? {};
  const refA = makeReference(origin, 'A', masks);
  const refB = makeReference(origin, 'B', masks);
  assert.equal((await host.ctl({ mode: 'compare', action: 'rate', side: 'A', rate: 2 })).ok, true);
  const startPair = host.snapshot('compare').comparison;
  for (let tick = 1; tick <= 100; tick += 1) {
    assert.equal((await host.ctl({ mode: 'compare', action: 'step' })).ok, true);
    await tickSurvPlay(refA, { minutes: 60 });
    await tickSurvPlay(refB, { minutes: 60 });
    const record = readJson('comparison.json');
    const pair = host.snapshot('compare').comparison;
    assert.equal(pair.A.clock.rate, 2);
    assert.equal(pair.B.clock.rate, 1);
    assert.equal(pair.A.t, startPair.A.t + tick);
    assert.equal(pair.B.t, startPair.B.t + tick);
    assertSameWorld(stableDump(record.branches.A.world), stableDump(dumpSurv(refA)),
      `第 ${tick} 拍 A 必须逐位等于单独跑`);
    assertSameWorld(stableDump(record.branches.B.world), stableDump(dumpSurv(refB)),
      `第 ${tick} 拍 B 必须逐位等于单独跑（倍速侧不得改写另一侧）`);
  }
});

test('V11-CMP-09 act 在 tick 在途时可返回；compare 的 act/tick 不交叉写 A/B', async (t) => {
  await host.start();
  t.after(() => { host.stop(); });
  const pair = await freshCompare();
  const revision = pair.revision;
  const { Organism } = await import('./agent.mjs');
  const original = Organism.prototype.tick;
  let enteredResolve, releaseTick;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseTick = resolve; });
  Organism.prototype.tick = async function slowTick(world) {
    enteredResolve();
    await gate;
    return original.call(this, world);
  };
  try {
    host.touch('compare'); // 让宿主 tick 也推进 A/B 世界，使 step 真的 await 到居民 tick
    let stepDone = false;
    const step = host.ctl({ action: 'step' }).finally(() => { stepDone = true; });
    // 在途闸门必须真的挡住一拍，否则下面的“在途”断言没有意义。
    const enteredInTime = await Promise.race([
      entered.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(enteredInTime, true, '主 tick 必须能进入被挡住的居民 tick');
    assert.equal(stepDone, false, '主 tick 必须仍在途');
    const before = host.snapshot('compare').comparison;
    const started = Date.now();
    const acted = await host.act({ mode: 'compare', revision, kind: 'move', room: 'home' });
    const elapsed = Date.now() - started;
    assert.equal(acted.ok, true, JSON.stringify(acted));
    assert.equal(stepDone, false, 'compare act 不得等主 tick 跑完');
    assert.ok(elapsed < 1500, `compare act 不应排在主 tick/模型后面：${elapsed}ms`);
    const during = host.snapshot('compare').comparison;
    // 状态读：act 落在两侧自己身上，时钟/刻/revision 都不动（没有借一次 tick）。
    assert.equal(during.revision, revision);
    assert.equal(during.A.t, before.A.t);
    assert.equal(during.B.t, before.B.t);
    // 时钟是实时读法：只允许毫秒级的 gameMinutes 差，rate/paused/派生 t 必须不动。
    const clockFacts = ({ gameMinutes, ...rest }) => rest;
    assert.deepEqual(clockFacts(during.A.clock), clockFacts(before.A.clock));
    assert.deepEqual(clockFacts(during.B.clock), clockFacts(before.B.clock));
    assert.ok(Math.abs(during.A.clock.gameMinutes - before.A.clock.gameMinutes) < 0.5);
    assert.equal(during.A.loc.p1, 'home', 'A 的玩家位置必须真的改了');
    assert.equal(during.B.loc.p1, 'home', 'B 的玩家位置必须真的改了');
    // A/B 各写自己那一条动作日志，不能一侧的结果串到另一侧。
    const logA = during.A.researchLog?.at(-1), logB = during.B.researchLog?.at(-1);
    assert.equal(logA?.who, '玩家'); assert.equal(logB?.who, '玩家');
    assert.match(String(logA?.text), /move/); assert.match(String(logB?.text), /move/);
    assert.equal(during.A.researchLog.filter((row) => row.who === '玩家').length, 1);
    assert.equal(during.B.researchLog.filter((row) => row.who === '玩家').length, 1);
    releaseTick();
    await step;
    const after = host.snapshot('compare').comparison;
    // 主 tick 跑完后 compare 仍一致，且能继续正常推进。
    assert.equal(after.revision, revision);
    assert.equal(host.status().tickError ?? null, null);
    assert.equal((await host.ctl({ mode: 'compare', action: 'step' })).ok, true);
  } finally {
    releaseTick();
    Organism.prototype.tick = original;
  }
});




// 时间节奏 1:10 专项闸门。
//
// 口径：现实 1 分钟 = 10 游戏分；1 游戏分 = 6000ms；1 天 1440 游戏分 = 144 现实分钟。
// 全用假时钟/显式推进，不真实等待 60s 或 144min。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSimClock, DEFAULT_MS_PER_GAME_MINUTE, GAME_MINUTES_PER_DAY } from './sim-clock.mjs';
import { createSimScheduler, gameMinutesForRealMinutes } from './sim-scheduler.mjs';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import {
  FALLBACK_MS_PER_GAME_MINUTE, FALLBACK_TICK_MS,
  interpolateGameMinutes, clockAnchorFromView, tickMsFromView,
} from '../web/time-view.mjs';

const MIN = 6000;
// 本文件钉正式默认；避免外层 shell 的覆盖值改变闸门含义。
delete process.env.GAME_MS_PER_MINUTE;
const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
  playerRation: true,
};
const READ = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('PACE-01 默认 6000ms/游戏分；TICK_MS 不再是回退来源，env 可覆盖', () => {
  assert.equal(DEFAULT_MS_PER_GAME_MINUTE, 6000);
  assert.equal(FALLBACK_MS_PER_GAME_MINUTE, 6000);
  assert.equal(FALLBACK_TICK_MS, 360000);
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  assert.equal(c.msPerGameMinute, 6000, '显式 tickMs=7500 也不得把默认拉回 125ms');
  now = MIN;
  assert.equal(c.nowMinutes(), 1);
  const old = process.env.GAME_MS_PER_MINUTE;
  try {
    process.env.GAME_MS_PER_MINUTE = '2500';
    assert.equal(createSimClock({ now: () => 0 }).msPerGameMinute, 2500);
  } finally {
    if (old === undefined) delete process.env.GAME_MS_PER_MINUTE;
    else process.env.GAME_MS_PER_MINUTE = old;
  }
});

test('PACE-02 现实 60s 推进 10 游戏分；一天 1440 分 = 144 现实分钟', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  now = 60_000;
  assert.equal(c.nowMinutes(), 10, '现实 60s 必须正好 10 游戏分');
  now = 144 * 60_000;
  assert.equal(c.nowMinutes(), GAME_MINUTES_PER_DAY, '144 现实分钟 = 1440 游戏分');
  assert.equal(c.nowTick(), 24, '24 刻/天');
  // 1 游戏分 = 6000ms 的直接换算，不经过 480/125。
  now = MIN * 7;
  assert.equal(c.nowMinutes(), 7);
});

test('PACE-03 暂停冻结、恢复不欠不补；倍速严格按 rate（60s 基准）', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  now = 60_000;
  assert.equal(c.nowMinutes(), 10);
  c.pause(now);
  now += 60_000;
  assert.equal(c.nowMinutes(), 10, '暂停 60s 不得走 10 分');
  c.resume(now);
  now += 60_000;
  assert.equal(c.nowMinutes(), 20, '恢复后只走之后的 60s，不补暂停段');

  const fast = createSimClock({ now: () => 0, rate: 2 });
  assert.equal(fast.nowMinutes(60_000), 20, 'rate=2：现实 60s = 20 游戏分');
  const slow = createSimClock({ now: () => 0, rate: 0.5 });
  assert.equal(slow.nowMinutes(60_000), 5, 'rate=0.5：现实 60s = 5 游戏分');
  fast.setRate(1, 60_000);
  assert.equal(fast.nowMinutes(60_000), 20, '换挡不跳变');
  assert.equal(fast.nowMinutes(120_000), 30, '换挡后按新 rate 走');
});

test('PACE-04 Scheduler 以 6000ms 整分叫醒；离线补时 1 真实分=10 游戏分', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  const sched = createSimScheduler({ clock: c, cursor: () => 0, now: () => now });
  assert.equal(sched.peek(5999).minutes, 0, '差 1ms 不得提前到下一分');
  now = 6000;
  assert.equal(sched.peek(now).minutes, 1, '6000ms 正好 1 游戏分');
  now = 60_000;
  assert.equal(sched.peek(now).minutes, 10, '60s 欠 10 整分');
  now = 60_000;
  assert.ok(sched.nextDelayMs(now) <= 1000, '正式节奏下叫醒延迟不得退化为分钟级空转');
  assert.equal(gameMinutesForRealMinutes(1, c), 10);
  assert.equal(gameMinutesForRealMinutes(60, c), 600, '60 真实分 = 600 游戏分（cap 7200 内）');
});

test('PACE-05 前端 fallback/插值/表现层 tick 与 1:10 同源', () => {
  const anchor = { gameMinutes: 360, at: 0, rate: 1, msPerGameMinute: 6000, paused: false };
  assert.ok(Math.abs(interpolateGameMinutes(anchor, 5000) - (360 + 5 / 6)) < 1e-9);
  assert.equal(interpolateGameMinutes(anchor, 3000), 360.5);
  assert.equal(interpolateGameMinutes(anchor, 6000), interpolateGameMinutes(anchor, 5000),
    '显示层 5s 封顶；服务端 1:10 真值由 sim-clock 闸门覆盖');
  assert.equal(clockAnchorFromView({ timeMode: 'continuous', gameMinutes: 1, clock: {} }).msPerGameMinute, 6000,
    'clock 缺字段时回退 6000，不得回到 125');
  assert.equal(tickMsFromView({ timeMode: 'continuous', clock: { msPerGameMinute: 6000 } }), 360000,
    '一刻=60×6000ms，前端不再把 7500 当正式节奏');
});

test('PACE-06 研究态无 simClock 不漂移；正式长程 manual clock 保持显式分钟推进', async () => {
  // 研究态：没有 simClock，tickSurvPlay 仍按 1 刻=60 分走（旧语义逐位不动）。
  const research = createSurvPlay(7, { unifiedCooperation: true });
  assert.equal(research.world.simClock, undefined, '研究态不得因默认变化创建 simClock');
  const t0 = research.world.t;
  await tickSurvPlay(research);
  assert.equal(research.world.t, t0 + 1, '研究态仍是每 tick +1 刻');

  // 正式长程：manual clock 的时间只由 advanceMinutes/setGameMinutes 决定，与 6000 默认无关。
  const now = 0;
  const clock = createSimClock({ now: () => now, manual: true });
  clock.setGameMinutes(600);
  clock.advanceMinutes(1440);
  assert.equal(clock.nowMinutes(), 2040);
  assert.equal(clock.nowTick(), 34);
  clock.pause(now);
  assert.equal(clock.nowMinutes(), 2040, 'manual 长程的推进不依赖默认 msPerGameMinute');
});

test('PACE-07 源码不得留下 125/480 回退或 TICK_MS/60 换算', () => {
  const clockSrc = READ('life/sim-clock.mjs');
  const schedSrc = READ('life/sim-scheduler.mjs');
  const timeView = READ('web/time-view.mjs');
  assert.doesNotMatch(clockSrc, /TICK_MS\s*\/\s*60|safeTickMs\s*\/\s*GAME_MINUTES_PER_HOUR/,
    'sim-clock 不得再用 TICK_MS/60 回退');
  assert.doesNotMatch(clockSrc, /msPerGameMinute\s*,\s*125\b/, 'sim-clock 不得留 125 兜底');
  assert.doesNotMatch(schedSrc, /msPerGameMinute\s*,\s*125\b/, 'scheduler 不得留 125 兜底');
  assert.doesNotMatch(timeView, /FALLBACK_MS_PER_GAME_MINUTE\s*=\s*125\b/, '前端 fallback 必须 6000');
  assert.match(clockSrc, /DEFAULT_MS_PER_GAME_MINUTE\s*=\s*6000/);
  assert.match(timeView, /FALLBACK_MS_PER_GAME_MINUTE\s*=\s*6000/);
});

test('PACE-08 旧 125ms 存档读入后按新默认 6000ms 接续，不保留旧节奏', () => {
  const oldClock = createSimClock({ now: () => 0, msPerGameMinute: 125, manual: true });
  const sp = createSurvPlay(7, { ...GAME, simTime: true, simClock: oldClock });
  oldClock.setGameMinutes(600);
  const raw = structuredClone(dumpSurv(sp));
  assert.equal(raw.clock.msPerGameMinute, 125, '夹具必须是旧节奏档');
  const back = loadSurv(raw, 7, { ...GAME, simTime: true });
  assert.equal(back.world.simClock.msPerGameMinute, 6000, '读档不得把 125ms 的旧节奏带进新游戏');
  assert.equal(back.world.simClock.nowTick(), 10, '读档仍按 t=10 的分钟重锚');
});

// P1 连续时钟单元闸门：换算/派生刻/暂停/倍速/令牌桶。
// 正式节奏 1 游戏分钟 = 6000ms（现实 1 分钟 = 10 游戏分）；TICK_MS 不再参与换算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimClock, createTokenBucket, DEFAULT_MS_PER_GAME_MINUTE } from './sim-clock.mjs';

const MIN = 6000; // ms/游戏分
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// 本文件钉默认值；不让外层 shell 的 GAME_MS_PER_MINUTE 改变闸门含义。
delete process.env.GAME_MS_PER_MINUTE;

test('CLOCK-01 默认 6000ms/游戏分：现实 1 分钟 = 10 游戏分，t 是派生的整 60 分', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  assert.equal(DEFAULT_MS_PER_GAME_MINUTE, 6000);
  assert.equal(c.msPerGameMinute, 6000);
  assert.equal(c.nowMinutes(), 0);
  now = MIN;
  assert.equal(c.nowMinutes(), 1, '6000ms 必须正好 1 游戏分钟');
  assert.equal(c.nowTick(), 0);
  now = 60_000;
  assert.equal(c.nowMinutes(), 10, '现实 1 分钟必须走 10 游戏分');
  now = 360_000;
  assert.equal(c.nowMinutes(), 60);
  assert.equal(c.nowTick(), 1);
  assert.equal(c.state().t, 1);
  now = 1440 * MIN;
  assert.equal(c.nowMinutes(), 1440, '正式一天 1440 游戏分');
  assert.equal(c.nowTick(), 24);
});

test('CLOCK-01b TICK_MS 不得把默认时钟回退成 125ms；GAME_MS_PER_MINUTE 可覆盖', () => {
  let now = 0;
  // 显式传 tickMs 只是旧调用签名兼容：换算不得再读它。
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  assert.equal(c.msPerGameMinute, 6000, 'TICK_MS/60 回退必须消失');
  now = 125;
  assert.ok(c.nowMinutes() < 0.03, `125ms 不该是 1 游戏分，实测 ${c.nowMinutes()}`);
  try {
    process.env.GAME_MS_PER_MINUTE = '2500';
    const envClock = createSimClock({ now: () => 0 });
    assert.equal(envClock.msPerGameMinute, 2500, 'GAME_MS_PER_MINUTE 必须可覆盖');
    assert.equal(createSimClock({ now: () => 0, msPerGameMinute: 500 }).msPerGameMinute, 500,
      '显式参数优先于 env');
    process.env.GAME_MS_PER_MINUTE = '0';
    assert.equal(createSimClock({ now: () => 0 }).msPerGameMinute, 6000, '0/空值必须回落 6000 而不是除零');
  } finally {
    delete process.env.GAME_MS_PER_MINUTE;
  }
});

test('CLOCK-02 advance 显式推进：测试/离线补时不依赖真实时间', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  c.advanceMinutes(30);
  assert.equal(c.nowMinutes(), 30);
  assert.equal(c.nowTick(), 0);
  c.advance(MIN * 30);
  assert.equal(c.nowMinutes(), 60);
  assert.equal(c.nowTick(), 1);
});

test('CLOCK-03 暂停期间世界冻结，恢复后不欠不补', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  now = MIN * 10;
  c.pause(now);
  now += MIN * 100;
  assert.equal(c.nowMinutes(), 10, '暂停期间不得前进');
  c.resume(now);
  now += MIN * 5;
  assert.equal(c.nowMinutes(), 15, '恢复后从暂停点继续，不补暂停的 100 分钟');
});

test('CLOCK-04 rate 是倍速：同一段真实时间走双倍游戏分钟，换挡不跳变', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, rate: 2 });
  now = 60_000; // 1 真实分钟
  assert.equal(c.nowMinutes(), 20, 'rate=2 时 1 真实分应走 20 游戏分（默认 10 的两倍）');
  const before = c.nowMinutes();
  c.setRate(4, now);
  assert.ok(close(c.nowMinutes(now), before), '换挡瞬间世界分钟不得跳变');
  now += 60_000;
  assert.equal(c.nowMinutes(), before + 40);
});

test('CLOCK-06 rate=0 是冻结：不除零/NaN，startMinutes 不归零', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, rate: 0, startMinutes: 720 });
  assert.equal(c.nowMinutes(), 720, 'GAME_SPEED=0 必须停在 startMinutes，而不是公式乘 0 归零');
  assert.equal(c.state().t, 12);
  assert.ok(Number.isFinite(c.state().gameMinutes));
  now = MIN * 1000;
  assert.equal(c.nowMinutes(), 720, '真实时间流逝不得推动 rate=0 的钟');
  assert.equal(c.advanceMinutes(60), 720, 'rate=0 下显式推进也不得改变冻结分钟');
  c.setGameMinutes(900);
  assert.equal(c.nowMinutes(), 900, 'setGameMinutes 必须能钉住冻结分钟');
  assert.equal(c.state().t, 15);
  c.pause(now);
  assert.equal(c.nowMinutes(), 900);
  now += MIN * 10;
  c.resume(now);
  assert.equal(c.nowMinutes(), 900, 'rate=0 + pause/resume 仍冻结');
  c.setRate(1, now);
  assert.equal(c.nowMinutes(), 900, '从 0 换回 1× 不跳变');
  now += MIN * 5;
  assert.equal(c.nowMinutes(), 905, '换回正速率后从冻结分钟继续走');
});

test('CLOCK-07 setGameMinutes/pause/resume 边界：不欠不补，且 t 与 nowTick 同源', () => {
  let now = 0;
  const c = createSimClock({ now: () => now });
  c.setGameMinutes(59.999);
  assert.equal(c.state().t, 0, '未跨过整点仍属第 0 刻');
  assert.equal(c.state().t, c.nowTick(), 'state().t 必须复用 nowTick 的浮点吸收');
  c.setGameMinutes(60);
  assert.equal(c.state().t, 1);
  assert.equal(
    createSimClock({ now: () => 0, msPerGameMinute: 7499 / 60, startMinutes: 60 }).state().t,
    createSimClock({ now: () => 0, msPerGameMinute: 7499 / 60, startMinutes: 60 }).nowTick(),
    '非整除 msPerGameMinute 下 state().t 与 nowTick 仍一致',
  );
  now = 0;
  c.pause(now);
  now += MIN * 100;
  assert.equal(c.nowMinutes(), 60, '暂停期间不前进');
  c.resume(now);
  now += MIN * 5;
  assert.equal(c.nowMinutes(), 65, '恢复后不补暂停的 100 分钟');
});

test('CLOCK-08 state() 可 JSON 往返，不含 NaN/Infinity 内部值', () => {
  const c = createSimClock({ now: () => MIN * 7, startMinutes: 3.5 });
  const s = c.state();
  const round = JSON.parse(JSON.stringify(s));
  assert.deepEqual(round, s);
  for (const key of ['anchorMs', 'rate', 'paused', 'pausedAtMs', 'msPerGameMinute', 'gameMinutes', 't']) {
    assert.ok(Object.hasOwn(s, key), `state() 缺 ${key}`);
  }
  assert.equal(Number.isFinite(s.anchorMs), true);
  assert.equal(Number.isFinite(s.gameMinutes), true);
  assert.equal(Number.isInteger(s.t), true);
  assert.equal(s.msPerGameMinute, 6000);
});

test('CLOCK-05 真实毫秒令牌桶：容量、补充与耗尽', () => {
  let now = 0;
  const b = createTokenBucket({ now: () => now, capacity: 2, refillMs: 1000 });
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, '容量 2 用完后必须拒绝');
  now = 2000;
  assert.equal(b.take(), true, '2 秒补 2 个');
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

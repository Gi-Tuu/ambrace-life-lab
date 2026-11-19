// P1 连续时钟单元闸门：换算/派生刻/暂停/倍速/令牌桶。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimClock, createTokenBucket } from './sim-clock.mjs';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('CLOCK-01 默认 7.5s/60min：125ms 一游戏分钟，t 是派生的整 60 分', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  assert.equal(c.nowMinutes(), 0);
  now = 125;
  assert.equal(c.nowMinutes(), 1);
  assert.equal(c.nowTick(), 0);
  now = 7500;
  assert.equal(c.nowMinutes(), 60);
  assert.equal(c.nowTick(), 1);
  assert.equal(c.state().t, 1);
});

test('CLOCK-02 advance 显式推进：测试/离线补时不依赖真实时间', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  c.advanceMinutes(30);
  assert.equal(c.nowMinutes(), 30);
  assert.equal(c.nowTick(), 0);
  c.advance(125 * 30);
  assert.equal(c.nowMinutes(), 60);
  assert.equal(c.nowTick(), 1);
});

test('CLOCK-03 暂停期间世界冻结，恢复后不欠不补', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  now = 125 * 10;
  c.pause(now);
  now += 125 * 100;
  assert.equal(c.nowMinutes(), 10, '暂停期间不得前进');
  c.resume(now);
  now += 125 * 5;
  assert.equal(c.nowMinutes(), 15, '恢复后从暂停点继续，不补暂停的 100 分钟');
});

test('CLOCK-04 rate 是倍速：同一段真实时间走双倍游戏分钟，换挡不跳变', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500, rate: 2 });
  now = 1250; // 10 真实秒
  assert.equal(c.nowMinutes(), 20, 'rate=2 时 1250ms 应走 20 游戏分钟（原本 10 分）');
  const before = c.nowMinutes();
  c.setRate(4, now);
  assert.ok(close(c.nowMinutes(now), before), '换挡瞬间世界分钟不得跳变');
  now += 1250;
  assert.equal(c.nowMinutes(), before + 40);
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

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

test('CLOCK-06 rate=0 是冻结：不除零/NaN，startMinutes 不归零', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500, rate: 0, startMinutes: 720 });
  assert.equal(c.nowMinutes(), 720, 'GAME_SPEED=0 必须停在 startMinutes，而不是公式乘 0 归零');
  assert.equal(c.state().t, 12);
  assert.ok(Number.isFinite(c.state().gameMinutes));
  now = 125 * 1000;
  assert.equal(c.nowMinutes(), 720, '真实时间流逝不得推动 rate=0 的钟');
  assert.equal(c.advanceMinutes(60), 720, 'rate=0 下显式推进也不得改变冻结分钟');
  c.setGameMinutes(900);
  assert.equal(c.nowMinutes(), 900, 'setGameMinutes 必须能钉住冻结分钟');
  assert.equal(c.state().t, 15);
  c.pause(now);
  assert.equal(c.nowMinutes(), 900);
  now += 125 * 10;
  c.resume(now);
  assert.equal(c.nowMinutes(), 900, 'rate=0 + pause/resume 仍冻结');
  c.setRate(1, now);
  assert.equal(c.nowMinutes(), 900, '从 0 换回 1× 不跳变');
  now += 125 * 5;
  assert.equal(c.nowMinutes(), 905, '换回正速率后从冻结分钟继续走');
});

test('CLOCK-07 setGameMinutes/pause/resume 边界：不欠不补，且 t 与 nowTick 同源', () => {
  let now = 0;
  const c = createSimClock({ now: () => now, tickMs: 7500 });
  c.setGameMinutes(59.999);
  assert.equal(c.state().t, 0, '未跨过整点仍属第 0 刻');
  assert.equal(c.state().t, c.nowTick(), 'state().t 必须复用 nowTick 的浮点吸收');
  c.setGameMinutes(60);
  assert.equal(c.state().t, 1);
  assert.equal(
    createSimClock({ now: () => 0, tickMs: 7499, startMinutes: 60 }).state().t,
    createSimClock({ now: () => 0, tickMs: 7499, startMinutes: 60 }).nowTick(),
    '非整除 msPerGameMinute 下 state().t 与 nowTick 仍一致',
  );
  now = 0;
  c.pause(now);
  now += 125 * 100;
  assert.equal(c.nowMinutes(), 60, '暂停期间不前进');
  c.resume(now);
  now += 125 * 5;
  assert.equal(c.nowMinutes(), 65, '恢复后不补暂停的 100 分钟');
});

test('CLOCK-08 state() 可 JSON 往返，不含 NaN/Infinity 内部值', () => {
  const c = createSimClock({ now: () => 125 * 7, tickMs: 7500, startMinutes: 3.5 });
  const s = c.state();
  const round = JSON.parse(JSON.stringify(s));
  assert.deepEqual(round, s);
  for (const key of ['anchorMs', 'rate', 'paused', 'pausedAtMs', 'msPerGameMinute', 'gameMinutes', 't']) {
    assert.ok(Object.hasOwn(s, key), `state() 缺 ${key}`);
  }
  assert.equal(Number.isFinite(s.anchorMs), true);
  assert.equal(Number.isFinite(s.gameMinutes), true);
  assert.equal(Number.isInteger(s.t), true);
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

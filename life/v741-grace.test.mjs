// V7.4.1 grace：窗口内保留目标，超窗才 GRACE_EXPIRED；grace=0 现状；读档连续。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { move } from './body.mjs';
import { createHash } from 'node:crypto';
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const gather = [{ id: 'g1', kind: 'gather', cost: 10 }];
const setup = (grace) => {
  process.env.M3_GRACE = String(grace);
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const a = sp.world.agents.a1;
  move(sp.world, 'a1', 'home');
  a.m3PrevGoal = 'maintain';
  a.m3Last = { previous: null, goal: 'maintain', remaining: 2, reused: false, interrupted: null };
  return { sp, a };
};

test('V741-GRACE 6 刻内保留目标、第 7 刻 GRACE_EXPIRED', () => {
  const { a } = setup(6);
  for (let i = 1; i <= 6; i += 1) {
    a.m3Choose(a.world ?? {}, gather);
    // 用真实 world 通过 tick 不好控，这里直接调用 m3Choose；world 由 createSurvPlay 提供
    assert.equal(a.m3Last.goal, 'maintain', '第 ' + i + ' 刻不得重置');
    assert.equal(a.m3Last.waited, i);
  }
  a.m3Choose({}, gather);
  assert.equal(a.m3Last.goal, null);
  assert.equal(a.m3Last.interrupted, 'GRACE_EXPIRED');
  delete process.env.M3_GRACE;
});

test('V741-GRACE grace=0 与现状一致（立即 only_coupling_actions）', () => {
  const { a } = setup(0);
  a.m3Choose({}, gather);
  assert.equal(a.m3Last.goal, null);
  assert.equal(a.m3Last.interrupted, 'only_coupling_actions');
  delete process.env.M3_GRACE;
});

test('V741-GRACE 读档后 waited 连续，超窗才失效', () => {
  const { sp, a } = setup(6);
  a.m3Choose(sp.world, gather);
  assert.equal(a.m3GraceWait, 1);
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  const b = back.world.agents.a1;
  assert.equal(b.m3GraceWait, 1, '读档必须恢复 waited');
  for (let i = 2; i <= 6; i += 1) { b.m3Choose(back.world, gather); assert.equal(b.m3Last.goal, 'maintain'); }
  b.m3Choose(back.world, gather);
  assert.equal(b.m3Last.interrupted, 'GRACE_EXPIRED');
  delete process.env.M3_GRACE;
});
test('V741-GRACE m3=off 时设置 M3_GRACE 不改变 1 日哈希', async () => {
  process.env.M3_GRACE = '12';
  const a = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: false } });
  const b = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  for (let i = 0; i < 24; i += 1) { await tickSurvPlay(a); await tickSurvPlay(b); }
  assert.equal(sha(dumpSurv(a)), sha(dumpSurv(b)));
  delete process.env.M3_GRACE;
});

test('V741-GRACE grace=1/2 边界：窗口内保留，超窗才 GRACE_EXPIRED', () => {
  const g1 = setup(1);
  g1.a.m3Choose({}, gather);
  assert.equal(g1.a.m3Last.goal, 'maintain', 'grace=1 第 1 刻保留');
  assert.equal(g1.a.m3Last.waited, 1);
  g1.a.m3Choose({}, gather);
  assert.equal(g1.a.m3Last.interrupted, 'GRACE_EXPIRED', 'grace=1 第 2 刻超窗');
  const g2 = setup(2);
  for (let i = 1; i <= 2; i += 1) { g2.a.m3Choose({}, gather); assert.equal(g2.a.m3Last.goal, 'maintain'); assert.equal(g2.a.m3Last.waited, i); }
  g2.a.m3Choose({}, gather);
  assert.equal(g2.a.m3Last.interrupted, 'GRACE_EXPIRED', 'grace=2 第 3 刻超窗');
  delete process.env.M3_GRACE;
});

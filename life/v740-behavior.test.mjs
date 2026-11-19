// V7.4.0 闸门：观测不扰动（同 seed dump 哈希一致）、窗口/分桶/身份一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureBehavior } from './behavior-quality-probe.mjs';

test('V740-B 观测不扰动：observed/control/repeat 的 dump 哈希一致，窗口=24 刻', async () => {
  const r = await measureBehavior(7, 1);
  assert.equal(r.ticks, 24);
  assert.equal(r.nonPerturbation.equalControl, true, JSON.stringify(r.nonPerturbation));
  assert.equal(r.nonPerturbation.equalRepeat, true, JSON.stringify(r.nonPerturbation));
  assert.ok(r.identity.length > 0);
  for (const row of r.residentRows) {
    const actions = Object.values(row.actions).reduce((a, n) => a + n, 0);
    const bucketSum = Object.values(row.buckets).reduce((a, b) => a + b.actions, 0);
    assert.equal(bucketSum, actions, '四时段动作数应等于总动作数');
    assert.ok(row.validDays >= 0);
  }
});

test('V740-B 同种子重复实验摘要一致（确定性）', async () => {
  const a = await measureBehavior(13, 1);
  const b = await measureBehavior(13, 1);
  assert.equal(a.nonPerturbation.observedHash, b.nonPerturbation.observedHash);
  assert.equal(JSON.stringify(a.residentRows.map((x) => [x.id, x.actions, x.minutes])), JSON.stringify(b.residentRows.map((x) => [x.id, x.actions, x.minutes])));
});

// V7.4.0b 观测闸门：720/24 刻、每刻需求一次、活跃+无动作=有效、生命周期名单对账、非扰动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureBehaviorB } from './behavior-quality-probe-b.mjs';

test('V740B 1 日：24 刻、每人每刻需求一次、活跃+无动作=有效刻、出生/死亡名单对账', async () => {
  const r = await measureBehaviorB(7, 1);
  assert.equal(r.ticks, 24);
  assert.equal(r.actualTicks, 24);
  assert.equal(r.nonPerturbation.equalControl, true, JSON.stringify(r.nonPerturbation));
  assert.equal(r.nonPerturbation.equalRepeat, true);
  for (const row of r.roster) {
    assert.equal(row.active + row.inactive, row.validTicks, `${row.id} 活跃+无动作应=有效刻`);
    if (row.alive) assert.equal(row.demandSamples, 24, `${row.id} 每刻需求应 24 次`);
    const phases = Object.values(row.phases);
    assert.equal(phases.reduce((a, n) => a + n, 0), row.demandSamples, '时段采样不丢');
    for (const p of Object.keys(row.phases)) assert.ok(['晨', '昼', '暮', '夜'].includes(p));
  }
  const sampled = new Set(r.lifecycle.sampled);
  assert.deepEqual([...sampled].sort(), [...r.roster.map((x) => x.id)].sort());
  assert.equal(r.goalState.m3Enabled, false, '默认 M3 未启用');
  assert.match(r.goalState.note, /未启用/);
});

test('V740B 同种子重复观测哈希一致', async () => {
  const a = await measureBehaviorB(13, 1);
  const b = await measureBehaviorB(13, 1);
  assert.equal(a.nonPerturbation.observedHash, b.nonPerturbation.observedHash);
  assert.deepEqual(a.roster.map((x) => [x.id, x.active, x.inactive]), b.roster.map((x) => [x.id, x.active, x.inactive]));
});

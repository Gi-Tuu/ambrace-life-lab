// V7.4.1 研究态闸门：M3 事件只取规划器、关系来源/方向、移动窗口分母、非扰动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroup } from './v741-experiment.mjs';

test('V741 M3 off：无目标事件；观测/无观测哈希一致；关系来源可解释', async () => {
  const r = await runGroup(7, 1, false);
  assert.equal(r.goalEnabled, false);
  assert.equal(r.goalEvents.length, 0);
  assert.equal(r.nonPerturbation.equalControl, true, JSON.stringify(r.nonPerturbation));
  assert.equal(r.nonPerturbation.equalRepeat, true);
  for (const e of r.relationEvents) {
    assert.equal(typeof e.df, 'number');
    assert.equal(typeof e.dt, 'number');
    assert.ok(['talk', 'contact(+3/+0.06)', 'unattributed'].includes(e.source));
  }
});

test('V741 M3 on：事件只用规划器状态，follow 可追溯；3/6/12 窗口分母一致', async () => {
  const r = await runGroup(7, 2, true);
  assert.equal(r.goalEnabled, true);
  for (const e of r.goalEvents) {
    assert.equal(e.inferred, false, '不得用推断冒充规划器事件');
    assert.ok(Array.isArray(e.follow));
  }
  const w = r.moveAnalysis;
  assert.equal(w[3].denominator, w[6].denominator);
  assert.equal(w[6].denominator, w[12].denominator);
  assert.ok(w[3].confirmed <= w[6].confirmed && w[6].confirmed <= w[12].confirmed);
  assert.equal(r.repeatStats.n, r.repeatStats.same + r.repeatStats.different + r.repeatStats.unknown);
  assert.equal(r.nonPerturbation.equalControl, true);
});

test('V741 同配置重复观测哈希一致', async () => {
  const a = await runGroup(13, 1, true);
  const b = await runGroup(13, 1, true);
  assert.equal(a.nonPerturbation.observedHash, b.nonPerturbation.observedHash);
  assert.equal(a.nonPerturbation.equalRepeat, true);
});

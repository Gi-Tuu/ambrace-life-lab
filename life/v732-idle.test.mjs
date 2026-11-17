// V7.3.2 第三批闸门：空闲测量必须完整跑满天数、逐居民有记录、分类不自相矛盾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureIdle } from './idle-probe.mjs';

test('V732-IDLE 2 日测满：可用 1440/日，分钟分类不超总额，空闲拆分可解释', async () => {
  const r = await measureIdle(7, 2);
  assert.ok(r.actualDays >= 2, '必须至少跨满 2 日（含起始日）');
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) {
    assert.equal(row.availableMin, 1440);
    const used = row.laborMin + row.moveMin + row.restMin + row.socialMin + row.otherMin;
    assert.ok(used <= row.usedMin + 1e-6, `分类分钟 ${used} 不得超过已用 ${row.usedMin}`);
    assert.ok(row.usedMin <= 1440 + 1e-6);
    assert.ok(row.voluntaryIdleMin + row.schedulingIdleMin >= 0);
    assert.ok(row.voluntaryIdleMin + row.schedulingIdleMin <= row.idleMin + 60 + 1e-6, '空闲分钟拆分误差不超过 60');
  }
  assert.ok(r.idleMin > 0);
});

test('V732-IDLE 同种子结果可复现（只测不改调度）', async () => {
  const a = await measureIdle(13, 1);
  const b = await measureIdle(13, 1);
  assert.deepEqual(a.totals, b.totals);
  assert.deepEqual(a.rows.map((x) => [x.id, x.usedMin]), b.rows.map((x) => [x.id, x.usedMin]));
});


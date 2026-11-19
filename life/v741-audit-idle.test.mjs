import test from 'node:test';
import assert from 'node:assert/strict';
import { measureIdle } from './idle-probe.mjs';
test('ARCH4-02 idle 机会不是常量：opportunity+scheduling 与总刻一致', async () => { const r = await measureIdle(7, 1); const o = r.rows.reduce((a, x) => a + x.opportunityTicks, 0); const s = r.rows.reduce((a, x) => a + (x.schedulingTicks ?? 0), 0); assert.equal(o + s, r.rows.reduce((a, x) => a + x.ticks, 0)); });
test('ARCH4-02 每刻最多一次需求/机会采样', async () => { const r = await measureIdle(7, 1); for (const row of r.rows) assert.ok(row.opportunityTicks + (row.schedulingTicks ?? 0) <= row.ticks); });
test('ARCH4-02 24 刻/日窗口', async () => { const r = await measureIdle(7, 1); assert.equal(r.ticksRun, 24); });

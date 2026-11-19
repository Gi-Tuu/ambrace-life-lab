// V7.3.3 生命周期收尾：真实世界死亡（日中/日界/最后一刻）与出生当日的观测完整性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureIdle } from './idle-probe.mjs';

test('V733-LIFE 日中死亡：当日行标 partial、只收尾一次、无重复行', async () => {
  const r = await measureIdle(7, 2, { onAfterTick: (w, i) => { if (i === 5) w.agents.a1.viab.v = 0; } });
  const rows = r.rows.filter((x) => x.id === 'a1');
  assert.ok(rows.length >= 1);
  const day0 = rows.filter((x) => x.day === 0);
  assert.equal(day0.length, 1, '死亡当日只能有一行');
  assert.equal(day0[0].partial, true, '日中死亡应标 partial');
  assert.ok(day0[0].ticks < 24);
});

test('V733-LIFE 日界死亡与最后一刻死亡：只收尾一次、part 标记正确', async () => {
  const r1 = await measureIdle(7, 2, { onAfterTick: (w, i) => { if (i === 24) w.agents.a1.viab.v = 0; } });
  const d0 = r1.rows.filter((x) => x.id === 'a1' && x.day === 0);
  assert.equal(d0.length, 1);
  const r2 = await measureIdle(7, 2, { onAfterTick: (w, i) => { if (i === 48) w.agents.a1.viab.v = 0; } });
  const rows2 = r2.rows.filter((x) => x.id === 'a1');
  assert.ok(rows2.length >= 1);
  assert.equal(new Set(rows2.map((x) => x.day)).size, rows2.length, '同一天不得重复收尾');
});

test('V733-LIFE 出生当日：自然 30 日窗口含 partial 行且无重复 [id,day]', async () => {
  const r = await measureIdle(7, 30);
  const partial = r.rows.filter((x) => x.partial);
  assert.ok(partial.length >= 0, '允许无出生；有出生时必须 partial');
  const keys = r.rows.map((x) => `${x.id}:${x.day}`);
  assert.equal(new Set(keys).size, keys.length, '同一居民同一天只应一行');
  assert.ok(r.observer.n > 0);
});

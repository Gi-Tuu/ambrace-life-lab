// C2/C3 闸门（PLAN §27）：旧档影响度计数标记 / 进度 EMA 持久化。默认路径不得多出存档键。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-archive-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json');
process.env.TICK_MS = '100000';

const { host } = await import('./host.mjs');
const snap = () => host.snapshot();
const agentsOf = (p) => Object.values(p.agents);

await host.start();
host.stop();
await host.ctl({ action: 'reset' }); // 落一份默认存档（默认世界从不写 cf*）

test('C2a 旧档缺 cfDecisions ⇒ 标记 incomplete，且 snapshot 可见', async () => {
  await host.start();
  host.stop();
  const s = snap();
  // PLAN §28 C：关系与规范必须进载荷（页面"关系与规范"面板只读这两项）
  assert.ok(Array.isArray(s.A.companions), 'snapshot 缺 companions');
  assert.ok(Array.isArray(s.A.normLog), 'snapshot 缺 normLog');
  for (const key of ['A', 'B']) for (const a of agentsOf(s[key])) {
    assert.equal(a.cfHistory, 'incomplete', `${key}/${a.id} 载入缺 cf* 的存档却没标历史不完整`);
    const nums = Object.values(a.counters).filter((v) => typeof v === 'number');
    assert.ok(nums.every((v) => Number.isFinite(v)), 'counters 里混进了非数值 ⇒ 消融表会被加成 NaN');
  }
});

test('C2b 带 cfDecisions 的存档不标 incomplete', async () => {
  await host.start(); // 本文件内多次 start/stop，先确保 packs 就绪再摸内部对象
  host.stop();
  for (const key of ['A', 'B']) for (const a of agentsOf(host.packs[key])) a.counters.cfDecisions = 7;
  await host.save();
  await host.start();
  host.stop();
  const s = snap();
  for (const key of ['A', 'B']) for (const a of agentsOf(s[key])) assert.equal(a.cfHistory, null, `${key}/${a.id} 有计数仍标不完整`);
});

test('C3a 进度 EMA 随档往返；C3b 默认存档不出现 lp 键', async () => {
  const raw0 = JSON.parse(readFileSync(join(DIR, 'world.json'), 'utf8'));
  for (const key of ['A', 'B']) for (const st of Object.values(raw0[key].agents)) assert.ok(!Object.hasOwn(st, 'lp'), '默认世界存档多出 lp 键 ⇒ 默认路径变了');
  host.packs.A.agents.a1.lpFast = 0.25;
  host.packs.A.agents.a1.lpSlow = 0.5;
  await host.save();
  await host.start();
  host.stop();
  const a1 = snap().A.agents.a1;
  assert.equal(a1.lpFast, undefined, 'snapshot 未暴露 lp（预期：仅存档往返，不新增载荷字段）');
  const raw = JSON.parse(readFileSync(join(DIR, 'world.json'), 'utf8'));
  assert.equal(raw.A.agents.a1.lp.fast, 0.25, 'lpFast 没写进存档');
  assert.equal(raw.A.agents.a1.lp.slow, 0.5, 'lpSlow 没写进存档');
  assert.equal(host.packs.A.agents.a1.lpFast, 0.25, '重新载入后 lpFast 没恢复');
  assert.equal(host.packs.A.agents.a1.lpSlow, 0.5, '重新载入后 lpSlow 没恢复');
});

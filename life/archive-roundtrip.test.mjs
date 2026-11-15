// 存档往返闸门（审计 2026-11-15 的 C-1/C-4）。
// 为什么要有它：上一轮修的"读档保留同屋顺序"用了"键数相等"做判据，而引擎会为
// "去过又离开"的房间保留空数组 ⇒ 真实存档永远走重建分支，顺序被按 loc 键序重排，
// 且 save→load→save 不幂等。当时的闸门夹具"所有房间都有人"，所以一直是绿的。
// 这里的每条都能被对应实现改坏而变红（变红法写在 test 名里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-roundtrip-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json');
process.env.TICK_MS = '100000';

const { host } = await import('./host.mjs');
const file = join(DIR, 'world.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));

await host.start();
host.stop();
await host.ctl({ action: 'reset' });

test('A-1 空房间键存在时，读档必须保留同屋顺序 【变红法：把 occupancy 判据改回"键数相等"】', async () => {
  await host.start();
  host.stop();
  const w = host.packs.A.world;
  w.loc.a1 = 'home'; w.loc.a2 = 'home'; w.loc.a3 = 'watch'; w.loc.p1 = 'hall';
  // 刻意与 loc 键序相反（a2 先到），并带一个空房间键 well
  w.occupancy = { home: ['a2', 'a1'], watch: ['a3'], hall: ['p1'], well: [] };
  const saved = JSON.parse(JSON.stringify(w.occupancy));

  await host.save();
  await host.start();
  host.stop();
  const got = host.packs.A.world.occupancy;

  assert.deepEqual(got.home, saved.home, `home 的顺序被重排（${saved.home} → ${got.home}）⇒ crowd[0]/othersAt 会变，决策分叉`);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(saved).sort(), '空房间键在往返中丢失 ⇒ save/load 不幂等');
});

test('A-2 save→load→save 必须幂等 【变红法：让 serialize 无条件落空 flags（applyInto 才会补成 {}）】', async () => {
  await host.start();
  host.stop();
  // 从"没有 flags 键"的状态起步：这样"serialize 无条件写 flags"才会在第二次落盘时
  // 多出 flags:{}（JSON 会把 undefined 丢掉，而重载后 applyInto 把它补成空对象）。
  delete host.packs.A.world.flags;
  delete host.packs.B.world.flags;
  for (let i = 0; i < 3; i += 1) await host.tickOnce();
  await host.save();
  const first = read();

  await host.start();
  host.stop();
  await host.save();
  const second = read();

  const strip = (doc) => {
    const copy = JSON.parse(JSON.stringify(doc));
    delete copy.savedAt;
    delete copy.missed;                 // 随离线时长变化，属预期
    if (copy.model) delete copy.model.attempts; // 诊断尾巴
    return copy;
  };
  assert.deepEqual(strip(second), strip(first), '重载后再落盘的内容变了 ⇒ 存档不是幂等的，字段会随重启漂移');
});

test('A-3 存档与 loc 不一致时必须重建，不能盲信存档 【变红法：删掉 rebuilt 房间的成员校验】', async () => {
  await host.start();
  host.stop();
  const w = host.packs.A.world;
  w.loc.a1 = 'watch'; w.loc.a2 = 'home';
  // 存档声称 a1 在 home —— 与 loc 冲突
  w.occupancy = { home: ['a1', 'a2'], watch: [] };
  await host.save();

  await host.start();
  host.stop();
  const got = host.packs.A.world.occupancy;
  assert.deepEqual([...(got.home ?? [])].sort(), ['a2'], `冲突的存档被盲信了：home=${JSON.stringify(got.home)}`);
  assert.ok((got.watch ?? []).includes('a1'), 'a1 应当出现在它 loc 指向的房间里');
});

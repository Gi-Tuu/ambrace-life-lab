// 存档版本闸门（审计 Batch 2）。
// 设计前提：**线上不能被版本号搞挂**。所以：
//   · 旧档没有 schemaVersion ⇒ 视为 1，照旧载入；
//   · 更高版本 ⇒ 兼容模式载入 + 一条警告，绝不拒载（否则回滚到旧程序就起不来）；
//   · 非数字 ⇒ 忽略该字段并警告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-schema-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json');
process.env.TICK_MS = '100000';

const { host } = await import('./host.mjs');
const file = join(DIR, 'world.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));
const write = (doc) => writeFileSync(file, JSON.stringify(doc), 'utf8');

await host.start();
host.stop();
await host.ctl({ action: 'reset' });

test('S-1 新档写入 schemaVersion，且当前版本不带警告 【变红法：把 serialize 的 schemaVersion 去掉】', async () => {
  await host.save();
  const doc = read();
  assert.equal(doc.schemaVersion, 1, '新档必须带 schemaVersion');
  await host.start();
  host.stop();
  assert.equal(host.snapshot().schemaWarning, null, '当前版本的档不该产生版本警告');
});

test('S-2 旧档（没有 schemaVersion）必须照旧载入 【变红法：把缺失分支当成拒载】', async () => {
  const doc = read();
  const t = doc.A.world.t;
  delete doc.schemaVersion;
  write(doc);

  await host.start();
  host.stop();
  const s = host.snapshot();
  assert.equal(s.A.t, t, `旧档没被载入（t=${s.A.t}，期望 ${t}）⇒ 线上存量存档会丢`);
  assert.equal(s.schemaWarning, null, '旧档是正常情况，不该报版本警告');
});

test('S-3 更高版本只警告不拒载（回滚安全）【变红法：把 >ARCHIVE_VERSION 改成 throw】', async () => {
  const doc = read();
  const t = doc.A.world.t;
  doc.schemaVersion = 999;
  write(doc);

  await host.start();
  host.stop();
  const s = host.snapshot();
  assert.equal(s.A.t, t, '更高版本的档被拒载了 ⇒ 回滚会直接起不来');
  assert.match(String(s.schemaWarning), /999/, '应当留下"版本更高"的警告，而不是静默');
});

test('S-4 schemaVersion 非数字时忽略该字段并警告 【变红法：删掉非数字分支】', async () => {
  const doc = read();
  doc.schemaVersion = 'v1';
  write(doc);

  await host.start();
  host.stop();
  const s = host.snapshot();
  assert.match(String(s.schemaWarning), /不是数字/, '非数字版本应被忽略并留下警告');
});

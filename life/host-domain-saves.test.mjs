// ARCH-HOST-SPLIT saves：写队列串行、合并窗口、原子提交、坏档隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWriteQueue, createCoalescer, writeArchiveAtomic, readArchiveFile, quarantineArchive,
} from './host-saves.mjs';

test('SAVES-01 写队列串行：后一个任务等前一个完成，失败不堵后续', async () => {
  const queue = createWriteQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { order.push('first:start'); await gate; order.push('first:end'); return 1; });
  const second = queue.enqueue(async () => { order.push('second'); return 2; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['first:start']);
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  await assert.rejects(queue.enqueue(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await queue.enqueue(async () => 3), 3);
  await queue.flush();
});

test('SAVES-02 合并窗口只跑一次；takeNow 立即踢起来', async () => {
  let runs = 0;
  const coalescer = createCoalescer({ delayMs: 15, run: async () => { runs += 1; } });
  coalescer.schedule();
  coalescer.schedule();
  coalescer.schedule();
  assert.equal(coalescer.pending(), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 1);
  assert.equal(coalescer.pending(), false);
  coalescer.schedule();
  coalescer.takeNow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs, 2);
});

test('SAVES-03 原子写：先备份旧档再 rename，无 tmp 残留；保留门禁止覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-saves-'));
  const file = join(dir, 'world.json');
  writeFileSync(file, '{"t":1}', 'utf8');
  const ok = await writeArchiveAtomic({ file, text: '{"t":2}', primaryValid: true });
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(file, 'utf8'), '{"t":2}');
  assert.equal(readFileSync(file + '.bak', 'utf8'), '{"t":1}');
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), []);
  const blocked = await writeArchiveAtomic({ file, text: '{"t":3}', primaryValid: true, preservePrimary: true });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /暂停覆盖/);
  assert.equal(readFileSync(file, 'utf8'), '{"t":2}');
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

test('SAVES-04 读档：主路径坏 M5 时回退跳过 M5 并带 warning；其它错误抛出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-saves-read-'));
  const file = join(dir, 'world.json');
  writeFileSync(file, '{"A":1}', 'utf8');
  const calls = [];
  const decoded = async (text, opts = {}) => {
    calls.push(opts.skipM5 === true);
    if (!opts.skipM5) throw Object.assign(new Error('bad m5'), { code: 'M5_STATE_INVALID' });
    return JSON.parse(text);
  };
  const { loaded, warning } = await readArchiveFile(file, { decode: decoded });
  assert.deepEqual(loaded, { A: 1 });
  assert.equal(warning, 'bad m5');
  assert.deepEqual(calls, [false, true]);
  await assert.rejects(readArchiveFile(file, { decode: async () => { throw Object.assign(new Error('shape'), { code: 'ARCHIVE_SHAPE' }); } }), /shape/);
});

test('SAVES-05 隔离坏档：改名保留现场，只留最近 N 份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-saves-q-'));
  for (let i = 0; i < 3; i += 1) writeFileSync(join(dir, `world.corrupt-${i}.json`), 'x');
  const file = join(dir, 'world.json');
  writeFileSync(file, '{}', 'utf8');
  const first = await quarantineArchive(dir, file, { keep: 2 });
  assert.equal(first.error, null);
  assert.equal(existsSync(file), false);
  const names = readdirSync(dir).filter((n) => n.startsWith('world.corrupt-')).sort();
  assert.equal(names.length, 2);
  assert.equal(existsSync(first.path), true);
  const missing = await quarantineArchive(dir, file, { keep: 2 });
  assert.equal(missing.path, null);
  assert.match(missing.error, /隔离失败/);
});

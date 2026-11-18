// 审计5 Batch 0：DATA5-04（索引锁/代际/6 进程 48/48）与 DATA5-06（key 严格 32hex、sweep 不越界）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIndex, writeIndex, touchSave, saveCamp, sweepSaves, savesDir } from './camp-instances.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'audit5-data-'));
const KEY = '0123456789abcdef0123456789abcdef';

test('DATA5-06 索引 key 必须是 32hex：穿越 key 被丢弃、saves 外文件不被删', () => {
  const d = dir();
  mkdirSync(savesDir(d), { recursive: true });
  const victim = join(d, 'victim.json.gz');
  writeFileSync(victim, 'keep');
  writeFileSync(join(savesDir(d), 'index.json'), JSON.stringify({
    entries: [
      { key: '../../victim', name: 'evil', lastSeenAt: 0 },
      { key: 'not-a-key', name: 'bad', lastSeenAt: 0 },
      { key: KEY, name: 'good', lastSeenAt: 0 },
    ],
  }));
  const idx = readIndex(d);
  assert.deepEqual(idx.entries.map((e) => e.key), [KEY], '只保留 32hex 条目');
  assert.equal(idx.droppedEntries, 2);
  sweepSaves(d, { now: Date.now() + 10 * 24 * 3600 * 1000 });
  assert.ok(existsSync(victim), 'saves/ 外的文件绝不能被 sweep 删除');
});

test('DATA5-06 非法 key 无法生成路径（saveCamp 抛 BAD_KEY）', () => {
  const d = dir();
  for (const bad of ['../../victim', 'A'.repeat(32), 'a'.repeat(31), 'z'.repeat(32), '', null]) {
    assert.throws(() => saveCamp(d, bad, { t: 0 }), (e) => e.code === 'BAD_KEY', String(bad));
  }
});

test('DATA5-04 锁超时 fail-fast：不无锁继续写，旧索引保持原样', () => {
  const d = dir();
  mkdirSync(savesDir(d), { recursive: true });
  writeIndex(d, { entries: [{ key: KEY, name: 'before' }] });
  const before = readFileSync(join(savesDir(d), 'index.json'), 'utf8');
  writeFileSync(join(savesDir(d), 'index.json.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  process.env.INDEX_LOCK_TIMEOUT_MS = '60';
  process.env.INDEX_LOCK_RETRY_MS = '5';
  try {
    assert.throws(
      () => writeIndex(d, { entries: [{ key: 'f'.repeat(32), name: 'after' }] }),
      (e) => e.code === 'INDEX_LOCKED',
    );
    assert.equal(readFileSync(join(savesDir(d), 'index.json'), 'utf8'), before, '超时后不得写入');
  } finally {
    delete process.env.INDEX_LOCK_TIMEOUT_MS;
    delete process.env.INDEX_LOCK_RETRY_MS;
    rmSync(join(savesDir(d), 'index.json.lock'), { force: true });
  }
});

test('DATA5-04 stale lock 回收：owner 时间戳过期后继续写并清锁', () => {
  const d = dir();
  mkdirSync(savesDir(d), { recursive: true });
  writeIndex(d, { entries: [{ key: KEY, name: 'before' }] });
  writeFileSync(join(savesDir(d), 'index.json.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 120000 }));
  const out = writeIndex(d, { entries: [{ key: 'f'.repeat(32), name: 'after' }] });
  assert.equal(out.entries, 1);
  assert.equal(existsSync(join(savesDir(d), 'index.json.lock')), false, '锁必须被清掉');
  assert.equal(readIndex(d).entries[0].name, 'after');
});

test('DATA5-04/03 6 进程 × 8 轮：48/48 条目与文件都不丢、索引带代际', async () => {
  const d = dir();
  const mod = pathToFileURL(resolve(import.meta.dirname, 'camp-instances.mjs')).href;
  const script = `
    const { saveCamp, touchSave } = await import(${JSON.stringify(mod)});
    const dir = process.env.DATA_DIR;
    const base = process.env.KEYBASE;
    for (let i = 0; i < 8; i += 1) {
      const key = (base + i.toString(16).padStart(2, '0')).padEnd(32, '0');
      saveCamp(dir, key, { t: i });
      touchSave(dir, { key, name: base + i, lastSeenAt: Date.now() });
    }
  `;
  const bases = ['a0', 'b0', 'c0', 'd0', 'e0', 'f0'];
  const children = bases.map((base) => spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DATA_DIR: d, KEYBASE: base, INDEX_LOCK_TIMEOUT_MS: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const results = await Promise.all(children.map((child) => new Promise((res) => {
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('exit', (code) => res({ code, err }));
  })));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const idx = readIndex(d);
  assert.equal(idx.entries.length, 48, `索引应保留 48 条，实测 ${idx.entries.length}`);
  assert.ok(idx.generation >= 48, `代际应递增，实测 ${idx.generation}`);
  const files = readdirSync(savesDir(d)).filter((n) => /^[0-9a-f]{32}\.json\.gz$/.test(n));
  assert.equal(files.length, 48, `营地档应保留 48 份，实测 ${files.length}`);
});

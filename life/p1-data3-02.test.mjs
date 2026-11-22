// P1 DATA3-02：坏索引不得删档；孤儿档改为隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepSaves, readIndex } from './camp-instances.mjs';

const DAY = 86400000;
const dirs = [];
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-data3-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'saves'), { recursive: true });
  return dir;
};
const oldFile = (dir, name, ageDays = 4) => {
  const file = join(dir, 'saves', name);
  writeFileSync(file, 'x');
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(file, t, t);
  return file;
};
const KEY = 'a'.repeat(32);

test('DATA3-02 坏索引 + 4 天前孤儿档：重启后文件仍在、一条都不删', () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'saves', 'index.json'), '{坏索引', 'utf8');
  const gz = oldFile(dir, `${KEY}.json.gz`, 4);
  const idx = readIndex(dir);
  assert.ok(idx.indexError, 'readIndex 必须返回损坏标记');
  const r = sweepSaves(dir, { now: Date.now() });
  assert.ok(existsSync(gz), '坏索引时不得删除孤儿档（隔离/删除都不行）');
  assert.equal(r.removed.length, 0, '坏索引时 TTL 也不得清档');
  assert.equal(r.indexError, undefined);
  assert.ok(r.indexUnhealthy === true, '必须显式报告索引不健康');
});

test('DATA3-02-QUARANTINE 健康索引 + 过期孤儿档：隔离到 quarantine，不 rm', () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'saves', 'index.json'), JSON.stringify({ entries: [] }));
  const gz = oldFile(dir, `${KEY}.json.gz`, 4);
  const r = sweepSaves(dir, { now: Date.now() });
  assert.equal(existsSync(gz), false, '原位置应已移走');
  const quarantined = join(dir, 'saves', 'quarantine', `${KEY}.json.gz`);
  assert.ok(existsSync(quarantined), '孤儿档必须隔离而不是删除');
  assert.equal(r.removed.length, 0);
  assert.equal(r.quarantined.length, 1);
});

test('DATA3-02-TTL 健康索引仍按 TTL 清已登记的过期档，正常档不受影响', () => {
  const dir = makeDir();
  const staleKey = 'b'.repeat(32);
  const freshKey = 'c'.repeat(32);
  const old = Date.now() - 30 * DAY;
  writeFileSync(join(dir, 'saves', 'index.json'), JSON.stringify({ entries: [
    { key: staleKey, name: '旧', lastSeenAt: old },
    { key: freshKey, name: '新', lastSeenAt: Date.now() },
  ] }));
  const stale = join(dir, 'saves', `${staleKey}.json.gz`);
  const fresh = join(dir, 'saves', `${freshKey}.json.gz`);
  writeFileSync(stale, 'x'); writeFileSync(fresh, 'x');
  const r = sweepSaves(dir, { now: Date.now() });
  assert.equal(existsSync(stale), false, '已登记且过期的档应清掉');
  assert.ok(existsSync(fresh), '新鲜档必须保留');
  assert.deepEqual(r.removed, [staleKey]);
});

test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

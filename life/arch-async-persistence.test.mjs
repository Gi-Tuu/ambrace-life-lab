// V7.3 异步持久化：6 营地 + 主营地并发 tick 时，tick 不 await 磁盘；flush 才等待落盘。
// 慢磁盘由 ARCH_SAVE_STALL_MS 故障注入（仅证据/测试用），阈值取 400ms 的 3/4，留 CI 抖动空间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

test('ARCH-ASYNC-01 6 营地 tick 不 await 400ms 磁盘；flush 收口且档案完整', () => {
  const r = spawnSync(process.execPath, ['scripts/arch-async-probe.mjs', 'measure'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.camps, 7, '应为 6 个名字营地 + 主营地');
  assert.equal(out.tickDidNotAwaitDisk, true, `tick 最大阻塞 ${out.tick.maxMs}ms，疑似 await 了磁盘`);
  assert.ok(out.tick.maxMs < 300, `tick 最大阻塞 ${out.tick.maxMs}ms`);
  assert.equal(out.flush.ok, true);
  assert.ok(out.flush.ms >= 350, `flush 只有 ${out.flush.ms}ms，慢磁盘注入没生效`);
  assert.equal(out.archives.indexEntries, 6);
  assert.equal(out.archives.allValid, true);
  assert.deepEqual(out.archives.campsT, [20, 20, 20, 20, 20, 20]);
  assert.equal(out.archives.mainSurvivalT, 20);
  assert.equal(out.archives.bakReadable, true);
});

test('ARCH-ASYNC-02 存档中途硬退出：旧档仍可读，重启后 6 个营地都能打开', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-async-crash-'));
  const r = spawnSync(process.execPath, ['scripts/arch-async-probe.mjs', 'crash'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, DATA_DIR: dir },
  });
  assert.equal(r.status, 1, `crash 探针应以 1 退出，实际 ${r.status}: ${r.stderr}`);
  // 断电点：旧一版主档/营地档仍在，且能被独立读出。
  const main = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  assert.ok(Number.isFinite(main.A?.world?.t));
  assert.ok(Number.isFinite(main.survival?.t));
  const { loadCamp, readIndex, validCampArchive } = await import('./camp-instances.mjs');
  const { entries } = readIndex(dir);
  assert.equal(entries.length, 6);
  for (const { key } of entries) {
    const raw = loadCamp(dir, key);
    assert.equal(validCampArchive(raw), true, `${key} 旧档损坏`);
    assert.ok(raw.t >= 10, `${key} t=${raw.t}`);
  }
  // 真重启：同一 DATA_DIR 装回世界，6 个营地都能按 key 打开。
  Object.assign(process.env, {
    DATA_DIR: dir, SEED_FILE: join(dir, 'missing-seed.json'),
    GAME_MODE: 'game', TICK_MS: '1000000', ACT_SAVE_COALESCE_MS: '0', BRAIN: 'local',
  });
  const { host } = await import('./host.mjs');
  await host.start();
  try {
    for (const { key } of entries) {
      const view = await host.readWorld('menu', key);
      assert.equal(view.camp.key, key);
      assert.ok(view.survival.t >= 10);
    }
  } finally {
    host.stop();
  }
});

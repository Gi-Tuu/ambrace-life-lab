// 审计5 Batch 0：DATA5-02/03 持久化成功口径（flush 硬屏障 / 营地写失败传播 / SIGTERM）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST_URL = pathToFileURL(resolve(import.meta.dirname, 'host.mjs')).href;

async function freshHost(t) {
  const dir = mkdtempSync(join(tmpdir(), 'audit5-persist-'));
  Object.assign(process.env, {
    DATA_DIR: dir,
    SEED_FILE: join(dir, 'missing-seed.json'),
    GAME_MODE: 'game', GAME_RULES: '1', TICK_MS: '10000000',
    ACT_SAVE_COALESCE_MS: '0', BRAIN: 'local',
  });
  delete process.env.ARCH_SAVE_STALL_MS;
  const mod = await import('./host.mjs');
  await mod.host.start();
  t.after(() => { mod.host.stop(); rmSync(dir, { recursive: true, force: true }); delete process.env.DATA_DIR; });
  return { mod, dir };
}

test('DATA5-02 flushWrites 是硬屏障：没到 t=10 也要有主档', async (t) => {
  const { mod, dir } = await freshHost(t);
  assert.equal(existsSync(join(dir, 'world.json')), false, 'start 后尚未排后台存档');
  const flushed = await mod.flushWrites();
  assert.equal(flushed.ok, true, JSON.stringify(flushed));
  assert.ok(existsSync(join(dir, 'world.json')), 'flush 之后必须有主档');
});

test('DATA5-02 营地写失败必须传播：save/flush 都不能报 ok', async (t) => {
  const { mod, dir } = await freshHost(t);
  const opened = await mod.openCamp('落盘失败营地');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const file = join(dir, 'saves', `${opened.key}.json.gz`);
  assert.ok(existsSync(file));
  rmSync(file);
  mkdirSync(file, { recursive: true }); // rename 必失败
  assert.equal(await mod.host.save(), false, 'save 必须返回 false');
  const flushed = await mod.flushWrites();
  assert.equal(flushed.ok, false, '营地失败时 flush 不得报 ok');
  assert.ok(flushed.saveError, '必须给出真实错误');
  assert.ok(flushed.camps[opened.key], '必须带营地明细');
  const status = mod.host.status();
  assert.ok(status.saveError);
  assert.ok(!String(status.saveError).includes(dir), '错误不得包含绝对路径');
  assert.ok(!/[A-Z]:\\|\/tmp\//.test(String(status.saveError)), `只回错误码：${status.saveError}`);
});

function runSignalProbe(script, dir) {
  const file = join(dir, 'sigterm-probe.mjs');
  writeFileSync(file, script);
  return new Promise((res) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, DATA_DIR: join(dir, 'data'), SEED_FILE: join(dir, 'missing-seed.json'), GAME_MODE: 'game', GAME_RULES: '1', TICK_MS: '10000000', BRAIN: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => res({ code, out }));
  });
}

test('DATA5-02 SIGTERM：保存失败必须非零退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit5-sig-'));
  const script = `
    import { rmSync, mkdirSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const { host, openCamp } = await import(${JSON.stringify(HOST_URL)});
    await host.start();
    const opened = await openCamp('信号失败营地');
    const file = join(process.env.DATA_DIR, 'saves', opened.key + '.json.gz');
    if (existsSync(file)) rmSync(file);
    mkdirSync(file, { recursive: true });
    process.emit('SIGTERM');
    await new Promise(() => {});
  `;
  const r = await runSignalProbe(script, dir);
  assert.equal(r.code, 1, `保存失败应以 1 退出，实测 ${r.code}: ${r.out.slice(-300)}`);
  assert.match(r.out, /关机前保存未完成/, 'stderr 必须说明失败');
  rmSync(dir, { recursive: true, force: true });
});

test('DATA5-02 SIGTERM：成功路径退出 0 且主档已落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit5-sig-ok-'));
  const script = `
    const { host } = await import(${JSON.stringify(HOST_URL)});
    await host.start();
    process.emit('SIGTERM');
    await new Promise(() => {});
  `;
  const r = await runSignalProbe(script, dir);
  assert.equal(r.code, 0, `成功路径应 0 退出，实测 ${r.code}: ${r.out.slice(-300)}`);
  assert.ok(existsSync(join(dir, 'data', 'world.json')), 'SIGTERM 必须等 flush 完成再退出');
  rmSync(dir, { recursive: true, force: true });
});

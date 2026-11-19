// 审计5 Batch 0：DATA5-02/03 持久化成功口径（flush 硬屏障 / 营地写失败传播 / SIGTERM）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

test('DATA5-01 start 立即写一次基线档；flush 硬屏障仍然成立', async (t) => {
  const { mod, dir } = await freshHost(t);
  assert.equal(existsSync(join(dir, 'world.json')), true, 'start 后必须有基线主档（首个 SAVE_EVERY 窗口可恢复）');
  assert.equal(mod.host.snapshot().saveWrites, 1, '启动基线只写一次');
  const flushed = await mod.flushWrites();
  assert.equal(flushed.ok, true, JSON.stringify(flushed));
  assert.equal(mod.host.snapshot().saveWrites, 1, 'flush 在无新状态时不得重复写同一刻');
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

test('DATA5-01 主档损坏时启动从 .bak 恢复最近完整档', async (t) => {
  const { mod, dir } = await freshHost(t);
  for (let i = 0; i < 10; i += 1) {
    await mod.host.tickOnce();
    await new Promise((r) => setImmediate(r));
  }
  await mod.flushWrites(); // 第一版 t=10 落盘，主档 = 10
  for (let i = 0; i < 10; i += 1) {
    await mod.host.tickOnce();
    await new Promise((r) => setImmediate(r));
  }
  await mod.flushWrites(); // 第二版 t=20：.bak 必须是 t=10
  const bak = JSON.parse(readFileSync(join(dir, 'world.json.bak'), 'utf8'));
  const bakT = bak.survival.t;
  assert.equal(bakT, 10, `备份档应是上一份完整档 t=10，实测 ${bakT}`);
  mod.host.stop();
  writeFileSync(join(dir, 'world.json'), 'not-json-at-all');
  const boot = await mod.host.start();
  assert.match(boot.note, /备份存档/, `启动必须明确说明从备份恢复：${boot.note}`);
  assert.equal(mod.host.status().campT, bakT, '恢复后的生存世界刻数必须来自 .bak');
});

test('DATA5-01 SAVE_EVERY 可配：=2 时硬退出前已落第 2 刻，不再固定丢 10 刻', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit5-save-every-'));
  const script = `
    const { host } = await import(${JSON.stringify(HOST_URL)});
    await host.start();
    for (let i = 0; i < 3; i += 1) await host.ctl({ action: 'step' });
    const deadline = Date.now() + 3000;
    while (host.snapshot().saveWrites < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    process.exit(0);
  `;
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, script);
  const r = spawnSync(process.execPath, [file], {
    env: {
      ...process.env, DATA_DIR: join(dir, 'data'), SEED_FILE: join(dir, 'missing-seed.json'),
      GAME_MODE: 'game', GAME_RULES: '1', TICK_MS: '10000000', BRAIN: 'local', SAVE_EVERY: '2',
    },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const main = JSON.parse(readFileSync(join(dir, 'data', 'world.json'), 'utf8'));
  assert.ok(main.survival.t >= 2, `SAVE_EVERY=2 时应已落第 2 刻，实测 ${main.survival.t}`);
  rmSync(dir, { recursive: true, force: true });
});

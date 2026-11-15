// 动作落盘合并闸门（审计 C-3，默认关闭的可选优化）。
// 为什么要有它：每个成功的生存动作都会整档落盘（实测 454 KB + .bak ≈ 908 KB/次）。
// 合并写能把连点合并成一次，但会换出一个"崩溃窗口"，所以**默认 0＝关闭**，只有显式配了
// ACT_SAVE_COALESCE_MS 才启用。这条闸门证明"开了确实合并、且停服会补写"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-coalesce-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json');
process.env.TICK_MS = '100000';
process.env.ACT_SAVE_COALESCE_MS = '600'; // 必须在 import host 之前设（窗口要明显长于 C-2 的等待，否则计时器自己会落地）

const { host } = await import('./host.mjs');
const worldFile = join(DIR, 'world.json');
const writes = () => host.snapshot().saveWrites ?? 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 轮询等到条件成立或超时：固定 sleep 在覆盖率插桩/慢盘上会抖。
const until = async (fn, deadlineMs) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > deadlineMs) return false;
    await sleep(25);
  }
  return true;
};

await host.start();
host.stop();
await host.ctl({ action: 'survival_reset', confirm: true });
await host.save();

test('C-1 开窗后连点只写一次，窗口到期补写 【变红法：把 persistAfterAction 里的计时器去掉（退成立即写）】', async () => {
  const before = writes();
  const mtimeBefore = statSync(worldFile).mtimeMs;
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await host.act({ mode: 'survival', kind: 'talk_close' }));
  assert.ok(results.every((r) => r.ok), '这组动作本身必须成功，否则测不到写盘');
  assert.ok(results.every((r) => r.persisted === true), '合并模式下动作仍应回报 persisted=true');
  const during = writes() - before;
  assert.ok(during <= 1, `窗口内写了 ${during} 次，应当 ≤1（合并没生效）`);

  assert.ok(await until(() => writes() - before >= 1, 3000), '窗口到期后必须补写一次（3s 内未补写）');
  const after = writes() - before;
  assert.ok(statSync(worldFile).mtimeMs >= mtimeBefore, '落盘时间应当前进了');
});

test('C-2 stop() 必须把窗口内的待写盘踢起来 【变红法：删掉 stop() 里的 takePendingFlush()】', async () => {
  const before = writes();
  const r = await host.act({ mode: 'survival', kind: 'talk_close' });
  assert.ok(r.ok);
  assert.equal(writes() - before, 0, '这一刻还在窗口里，不应已经写盘');
  host.stop();
  // 截止 500ms（仍小于 600ms 窗口）：只有 stop 主动补写才可能在这个期限内落地。
  assert.ok(await until(() => writes() - before >= 1, 500), 'stop() 之后没有补写 ⇒ 停服会丢这个窗口的动作');
});

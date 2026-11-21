// P1-2 重启离线补时闸门：正式连续世界（simClock）读档后必须按 savedAt 的真实停机时长、
// 同一 clock.rate 补进生存世界；不能因为 start() 开头把 S.missed 归零就静默不补，也不能补两遍。
//
// 口径：TICK_MS=1000000 ⇒ 1 游戏分钟 = 16666.67ms；GAME_SPEED=2 ⇒ 1 真实分 = 2×60×60000/16666.67
// = 432 游戏分。cap 仍是 SURV_CATCHUP_CAP×60 = 120×60 = 7200 游戏分。
// 【变红法：把 host-world.mjs 的 `if (minutes > 1)` 分支改回 `!S.surv?.world?.simClock` 才补 A/B】
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'v11-offline-restart-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';
process.env.TICK_MS = '1000000';
process.env.GAME_SPEED = '2';
process.env.SAVE_EVERY = '1';
process.env.ACT_SAVE_COALESCE_MS = '0';
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.PRESENCE_MS = '180000';

const { host, flushWrites } = await import('./host.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('V11-OFFLINE-01 停机 60 真实分：正式世界按同一 rate 补 432 游戏分（cap 7200），且只补一次', async (t) => {
  await host.start();
  t.after(() => host.stop());
  await host.ctl({ action: 'step' });
  await host.ctl({ action: 'step' });
  await host.save();
  await flushWrites();
  const before = host.snapshot('survival').survival;
  assert.equal(before.t, 2, '前置：两步之后世界在第 2 刻');

  const file = join(DIR, 'world.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.savedAt = Date.now() - 60 * 60 * 1000; // 伪造关服 60 分钟
  writeFileSync(file, JSON.stringify(raw));
  await host.stop();

  await host.start();
  const after = host.snapshot('survival').survival;
  const missed = host.status().missed;
  const applied = missed.survival ?? {};

  assert.equal(missed.minutes, 60, `停机横幅应记 60 分钟，实测 ${JSON.stringify(missed)}`);
  assert.equal(applied.capMinutes, 7200, 'cap 仍是 120 刻 = 7200 游戏分');
  assert.equal(applied.capped, false, '60 真实分 × rate 2 未到 cap');
  assert.equal(applied.requestedMinutes, 432, '离线与在线同一 rate：60 × 2 × 3.6 = 432 游戏分');
  assert.ok(applied.appliedMinutes >= 432 && applied.appliedMinutes <= 435,
    `实际补进 ${applied.appliedMinutes} 游戏分（期望 432，允许读档真实耗时带来的 <4 分）`);
  assert.equal(applied.applied, 7, '432 游戏分 = 7 个完整刻');
  assert.equal(after.t - before.t, 7, `世界刻 2 → ${after.t}；停机 60 真实分必须推进 7 刻`);
  // 读档/起服本身有真实耗时（TICK_MS=1000000、rate=2 ⇒ 1 游戏分≈8.3s），
  // before 快照到 savedAt/start 之间的毫秒差会带进世界分钟。容差 0.2 游戏分（≈1.7s 真实时间）
  // 只吸收这段读数噪声，不会放过“少补/多补一整刻”的语义错误（那至少差 60 分）。
  assert.ok(Math.abs((after.gameMinutes - before.gameMinutes) - applied.appliedMinutes) <= 0.2,
    `读档后世界分钟 ${after.gameMinutes} 与补时读数 ${applied.appliedMinutes} 对不上`);

  // 不重复补：自动调度在 TICK_MS=1000000 下要到几分钟后才叫醒；期间世界不得再跳。
  await sleep(150);
  assert.equal(host.snapshot('survival').survival.t, after.t, '读档后世界被补了第二遍');

  // 兼容边界：只带 A/B、没有 survival 块的旧档，readArchive 会新建一份生存世界；
  // 那份世界并不存在于停机期间，不能把这段离线时间算到它头上。
  await host.save();
  await flushWrites();
  const noSurv = JSON.parse(readFileSync(file, 'utf8'));
  delete noSurv.survival;
  noSurv.savedAt = Date.now() - 60 * 60 * 1000;
  writeFileSync(file, JSON.stringify(noSurv));
  await host.stop();
  await host.start();
  assert.equal(host.snapshot('survival').survival.t, 0, '没有 survival 块的档案不能凭空多出离线时间');
  assert.equal(host.status().missed.minutes, 0, '没有历史生存世界时不应写停机横幅');
});

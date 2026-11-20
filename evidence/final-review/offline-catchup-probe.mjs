// 只读审查探针：1.1 连续世界重启后的离线补时是否还发生（1.0.0 语义）。
// 不写仓库 data/，只写临时 DATA_DIR。用法：node evidence/final-review/offline-catchup-probe.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ambrace-review-offline-'));
process.env.DATA_DIR = dir;
process.env.SEED_FILE = join(dir, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.TICK_MS = '1000000';
process.env.SAVE_EVERY = '1';
process.env.ACT_SAVE_COALESCE_MS = '0';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '180000';

const { host, flushWrites } = await import('../../life/host.mjs');
await host.start();
await host.ctl({ action: 'step' });
await host.ctl({ action: 'step' });
await host.save();
await flushWrites();
const before = host.snapshot('survival').survival;
const file = join(dir, 'world.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));
const savedAt = raw.savedAt;
const clockBefore = raw.survival.clock ?? null;
// 伪造“关服 60 分钟”：与 1.0.0 的 catchUp 口径一致（savedAt 是真实时间）。
raw.savedAt = Date.now() - 60 * 60 * 1000;
writeFileSync(file, JSON.stringify(raw));
await host.stop();
await host.start();
const after = host.snapshot('survival').survival;
const startClock = host.status().clock;
const missed = host.status().missed;
const out = {
  before: { t: before.t, gameMinutes: before.gameMinutes, clock: clockBefore },
  savedAtBackdatedMin: 60,
  after: { t: after.t, gameMinutes: after.gameMinutes, clock: startClock },
  statusMissed: missed,
  advancedMinutes: Math.round((after.gameMinutes - before.gameMinutes) * 1000) / 1000,
  advancedTicks: after.t - before.t,
  verdict: after.t > before.t ? 'catchup-applied' : 'catchup-NOT-applied',
};
console.log(JSON.stringify(out, null, 2));
await host.stop();

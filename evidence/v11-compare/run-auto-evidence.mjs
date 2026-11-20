// 1.1 第 3 项证据：自动调度下 compare 的独立 pause/rate（真实 timer，TICK_MS=250）。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'v11-compare-auto-'));
process.env.DATA_DIR = dir;
process.env.SEED_FILE = join(dir, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.TICK_MS = '250';
process.env.SAVE_EVERY = '1000000';
process.env.ACT_SAVE_COALESCE_MS = '1000000';
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.MODEL_UNATTENDED = '0';
const { host } = await import('../../life/host.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snap = () => host.snapshot('compare');
const result = { generatedAt: new Date().toISOString(), tickMs: 250, steps: {} };
await host.start();
try {
  host.touch('compare');
  await host.ctl({ mode: 'compare', action: 'compare_reset', confirm: true, fromSurvival: true });
  await sleep(1500);
  let pair = snap().comparison;
  result.steps.warm = { tA: pair.A.t, tB: pair.B.t, minutesA: pair.A.clock.gameMinutes, minutesB: pair.B.clock.gameMinutes };

  await host.ctl({ mode: 'compare', action: 'pause', side: 'A' });
  pair = snap().comparison;
  const pausedA = pair.A.clock.gameMinutes, pausedB = pair.B.clock.gameMinutes;
  await sleep(1400);
  pair = snap().comparison;
  result.steps.sidePause = {
    A_paused: pair.A.clock.paused, B_paused: pair.B.clock.paused,
    deltaA: Number((pair.A.clock.gameMinutes - pausedA).toFixed(3)),
    deltaB: Number((pair.B.clock.gameMinutes - pausedB).toFixed(3)),
  };

  await host.ctl({ mode: 'compare', action: 'resume', side: 'A' });
  await host.ctl({ mode: 'compare', action: 'rate', side: 'A', rate: 2 });
  pair = snap().comparison;
  const rateA = pair.A.clock.gameMinutes, rateB = pair.B.clock.gameMinutes;
  await sleep(1400);
  pair = snap().comparison;
  const deltaA = pair.A.clock.gameMinutes - rateA, deltaB = pair.B.clock.gameMinutes - rateB;
  result.steps.sideRate = {
    A_rate: pair.A.clock.rate, B_rate: pair.B.clock.rate,
    deltaA: Number(deltaA.toFixed(3)), deltaB: Number(deltaB.toFixed(3)),
    ratio: Number((deltaA / Math.max(1e-9, deltaB)).toFixed(2)),
  };

  await host.ctl({ mode: 'compare', action: 'pause' });
  pair = snap().comparison;
  const globalA = pair.A.clock.gameMinutes, globalB = pair.B.clock.gameMinutes;
  await sleep(900);
  pair = snap().comparison;
  result.steps.globalPause = {
    compareRunning: snap().compareRunning,
    deltaA: Number((pair.A.clock.gameMinutes - globalA).toFixed(3)),
    deltaB: Number((pair.B.clock.gameMinutes - globalB).toFixed(3)),
  };
} finally {
  await host.stop();
}
console.log(JSON.stringify(result, null, 2));
writeFileSync('evidence/v11-compare/auto-evidence.json', JSON.stringify(result, null, 2) + '\n');

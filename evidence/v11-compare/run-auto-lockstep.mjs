// 1.1 第 3 项证据：自动调度下 A/B 两侧必须同步（同起点、同 rate ⇒ 同一游戏分钟）。
// 只比时钟读法与派生刻；两侧世界内容本来就因 B 的通道切断而分叉，不做逐位比较。
// 注意：snapshot 可能在“A 已推进、B 尚未推进”的同一拍中途被读到（差 1~2ms 的瞬时），
// 所以闸门是“没有任何一次跨整分钟偏差”，而不是要求每次读都逐位 0。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'v11-compare-auto-lockstep-'));
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

const result = { generatedAt: new Date().toISOString(), tickMs: 250, samples: [] };
await host.start();
try {
  host.touch('compare');
  assert.equal((await host.ctl({ mode: 'compare', action: 'compare_reset', confirm: true, fromSurvival: true })).ok, true);
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    const pair = host.snapshot('compare').comparison;
    result.samples.push({
      tA: pair.A.t, tB: pair.B.t,
      minutesA: pair.A.clock.gameMinutes, minutesB: pair.B.clock.gameMinutes,
      dtMinutes: Number((pair.A.clock.gameMinutes - pair.B.clock.gameMinutes).toFixed(6)),
      sameTick: pair.A.t === pair.B.t,
    });
  }
} finally {
  await host.stop();
}
const diffs = result.samples.map((s) => s.dtMinutes);
result.summary = {
  samples: result.samples.length,
  exactSamples: diffs.filter((d) => d === 0).length,
  maxAbsDtMinutes: Math.max(...diffs.map(Math.abs)),
  fullMinuteSkew: diffs.some((d) => Math.abs(d) >= 1),
  advanced: result.samples.at(-1).minutesA > result.samples[0].minutesA,
  sameTickAll: result.samples.every((s) => s.sameTick),
};
assert.equal(result.summary.fullMinuteSkew, false, 'A/B 不得出现整分钟偏差');
assert.equal(result.summary.advanced, true, '自动拍必须真的推进 compare');
assert.equal(result.summary.sameTickAll, true, 'A/B 派生刻必须一致');
console.log(JSON.stringify(result, null, 2));
writeFileSync('evidence/v11-compare/auto-lockstep.json', JSON.stringify(result, null, 2) + '\n');

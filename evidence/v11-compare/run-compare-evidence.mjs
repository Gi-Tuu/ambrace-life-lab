// 1.1 第 3 项证据：正式态 compare 连续钟 / 独立 A-B / 回放 / 旧档。
// 运行：node evidence/v11-compare/run-compare-evidence.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'v11-compare-evidence-'));
process.env.DATA_DIR = dir;
process.env.SEED_FILE = join(dir, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.TICK_MS = '1000000';
process.env.SAVE_EVERY = '1000000';
process.env.ACT_SAVE_COALESCE_MS = '1000000';
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.MODEL_UNATTENDED = '0';
const { host, flushWrites } = await import('../../life/host.mjs');
const stripClock = (world) => { const copy = structuredClone(world); delete copy.clock; return copy; };
const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const result = { generatedAt: new Date().toISOString(), dataDir: dir };
await host.start();
try {
  await host.ctl({ action: 'reset', confirm: true });
  assert((await host.ctl({ mode: 'compare', action: 'compare_reset', confirm: true, fromSurvival: true })).ok);
  let pair = host.snapshot('compare').comparison;
  result.start = {
    startTick: pair.startTick, A: pair.A.clock, B: pair.B.clock,
    AeqB: JSON.stringify(stripClock(read('comparison.json').branches.A.world)) === JSON.stringify(stripClock(read('comparison.json').branches.B.world)),
  };
  for (let i = 0; i < 6; i += 1) {
    assert((await host.ctl({ action: 'step' })).ok);
    assert((await host.ctl({ mode: 'compare', action: 'step' })).ok);
  }
  await flushWrites();
  pair = host.snapshot('compare').comparison;
  const record = read('comparison.json'), official = read('world.json').survival;
  result.trajectory = {
    tA: record.branches.A.world.t, tB: record.branches.B.world.t, tOfficial: official.t,
    AeqOfficial: JSON.stringify(stripClock(record.branches.A.world)) === JSON.stringify(stripClock(official)),
    Bdiverged: JSON.stringify(record.branches.A.world.survival.aiActions) !== JSON.stringify(record.branches.B.world.survival.aiActions),
  };

  const beforePause = pair;
  assert((await host.ctl({ mode: 'compare', action: 'pause', side: 'A' })).ok);
  assert((await host.ctl({ mode: 'compare', action: 'step' })).ok);
  pair = host.snapshot('compare').comparison;
  result.sidePause = {
    A_paused: pair.A.clock.paused, B_paused: pair.B.clock.paused,
    A_delta: pair.A.t - beforePause.A.t, B_delta: pair.B.t - beforePause.B.t,
    A_clock: pair.A.clock, B_clock: pair.B.clock,
  };
  assert((await host.ctl({ mode: 'compare', action: 'resume', side: 'A' })).ok);
  assert((await host.ctl({ mode: 'compare', action: 'rate', side: 'A', rate: 2 })).ok);
  pair = host.snapshot('compare').comparison;
  result.sideRate = { A_rate: pair.A.clock.rate, B_rate: pair.B.clock.rate };

  const replay = host.replay({ t: pair.A.t, revision: pair.revision });
  result.replay = {
    ok: replay.ok, frameMinute: replay.frame?.minute, sceneA_t: replay.scenes?.A?.t, sceneB_t: replay.scenes?.B?.t,
    locMatchA: JSON.stringify(replay.scenes?.A?.loc) === JSON.stringify(pair.A.loc),
    locMatchB: JSON.stringify(replay.scenes?.B?.loc) === JSON.stringify(pair.B.loc),
    occupancyMatchA: JSON.stringify(replay.scenes?.A?.occupancy) === JSON.stringify(pair.A.occupancy),
    occupancyMatchB: JSON.stringify(replay.scenes?.B?.occupancy) === JSON.stringify(pair.B.occupancy),
  };

  await flushWrites();
  const file = join(dir, 'comparison.json');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  for (const side of ['A', 'B']) {
    delete old.branches[side].world.clock;
    delete old.branches[side].world.weather;
  }
  for (const frame of old.replay.frames ?? []) { delete frame.minute; delete frame.minutes; }
  delete old.replay.sceneMinutes;
  await host.stop();
  writeFileSync(file, JSON.stringify(old));
  await host.start();
  const restored = host.snapshot('compare');
  const commonFrame = old.replay.frames.findLast((frame) =>
    frame.t === restored.comparison.A.t && frame.scene?.A?.t === frame.t && frame.scene?.B?.t === frame.t);
  const oldReplay = host.replay({ t: commonFrame.t, revision: restored.comparison.revision });
  result.oldArchive = {
    saveError: restored.compareSaveError,
    A_t: restored.comparison.A.t, B_t: restored.comparison.B.t, archiveT: old.branches.A.world.t,
    clocksRebuilt: Boolean(restored.comparison.A.clock && restored.comparison.B.clock),
    replayOk: oldReplay.ok, replayCode: oldReplay.code ?? null, replayNote: oldReplay.note ?? null,
    replayHasScenes: Boolean(oldReplay.scenes),
  };
} finally {
  await host.stop();
}
function assert(cond, message) { if (!cond) throw new Error(message ?? 'assert failed'); }
console.log(JSON.stringify(result, null, 2));
writeFileSync('evidence/v11-compare/compare-evidence.json', JSON.stringify(result, null, 2) + '\n');

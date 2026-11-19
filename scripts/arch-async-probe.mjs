// V7.3 异步持久化实测：6 个名字营地 + 主营地并发推进，记录 tick 阻塞/ flush 耗时 / 档完整性。
// 两种模式：
//   measure：慢磁盘注入（ARCH_SAVE_STALL_MS）下跑 20 刻，证明 tick 不 await 磁盘；
//   crash  ：flush 一版后，再推进 10 刻并在存档中途 process.exit(1)，供父进程验证旧档仍可读。
// 只写临时 DATA_DIR；不碰真实存档。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'measure';
const dir = process.env.DATA_DIR || mkdtempSync(join(tmpdir(), `arch-async-${mode}-`));
Object.assign(process.env, {
  DATA_DIR: dir,
  SEED_FILE: join(dir, 'missing-seed.json'),
  GAME_MODE: 'game',
  TICK_MS: '1000000',
  ACT_SAVE_COALESCE_MS: '0',
  BRAIN: 'local',
});

const { host, openCamp, campSurv, flushWrites } = await import('../life/host.mjs');
const { loadCamp, readIndex, validCampArchive } = await import('../life/camp-instances.mjs');
const { move } = await import('../life/body.mjs');

const step = async () => {
  const started = performance.now();
  await host.ctl({ action: 'step' });
  return performance.now() - started;
};

await host.start();
const camps = [];
for (let i = 0; i < 6; i += 1) {
  const opened = await openCamp(`异步营地${i}`);
  if (!opened.ok) throw new Error(`open camp ${i} failed: ${opened.code}`);
  camps.push(opened);
  host.touch('survival', opened.key);
  move(campSurv(opened.key).world, 'a1', 'yard');
}
host.touch('survival', 'MAIN');

if (mode === 'crash') {
  process.env.ARCH_SAVE_STALL_MS = '0';
  for (let i = 0; i < 10; i += 1) await step();
  await flushWrites();
  const baseline = {
    main: JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')).A.world.t,
    camps: Object.fromEntries(camps.map(({ key }) => [key, loadCamp(dir, key).t])),
  };
  process.env.ARCH_SAVE_STALL_MS = '1500';
  for (let i = 0; i < 10; i += 1) await step();
  // 第二版 save() 正卡在故障注入的 1.5s 里：此刻硬退出等同断电。
  setTimeout(() => process.exit(1), 100);
  await new Promise(() => {});
} else {
  process.env.ARCH_SAVE_STALL_MS = '400';
  const durations = [];
  for (let i = 0; i < 20; i += 1) durations.push(await step());
  // 让 tick 末尾 setImmediate 排的后台存档真正进入链，再 flush 收口。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const flushStarted = performance.now();
  const flushed = await flushWrites();
  const flushMs = performance.now() - flushStarted;
  // 再显式保存一次，确保主档 .bak 存在（旧档可读的样本）。
  await host.save();
  await flushWrites();

  const index = readIndex(dir);
  const archives = camps.map(({ key }) => {
    const raw = loadCamp(dir, key);
    return { key, t: raw.t, valid: validCampArchive(raw) };
  });
  const main = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  const durationsSorted = [...durations].sort((a, b) => a - b);
  let bakReadable = false;
  try { bakReadable = Number.isFinite(JSON.parse(readFileSync(join(dir, 'world.json.bak'), 'utf8')).A?.world?.t); } catch { /* 首版可能没有 bak */ }
  const result = {
    mode,
    dir,
    camps: camps.length + 1,
    ticks: 20,
    stallMs: 400,
    tick: {
      maxMs: Number(durationsSorted.at(-1).toFixed(2)),
      p95Ms: Number(durationsSorted[Math.floor(durations.length * 0.95)].toFixed(2)),
      minMs: Number(durationsSorted[0].toFixed(2)),
      all: durations.map((n) => Number(n.toFixed(2))),
    },
    flush: { ok: flushed.ok, ms: Number(flushMs.toFixed(2)) },
    archives: {
      indexEntries: index.entries.length,
      allValid: archives.every((a) => a.valid),
      campsT: archives.map((a) => a.t),
      mainSurvivalT: main.survival?.t ?? null,
      bakReadable,
    },
    tickDidNotAwaitDisk: durationsSorted.at(-1) < 400 * 0.75,
  };
  console.log(JSON.stringify(result));
  host.stop();
  process.exit(0);
}

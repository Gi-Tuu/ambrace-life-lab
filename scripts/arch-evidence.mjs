// 生成 evidence/arch-fix/multiproc-async.json：6 营地异步持久化 + 崩溃恢复的实测证据。
// 用法：node scripts/arch-evidence.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const run = (args, env = {}) => spawnSync(process.execPath, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { ...process.env, ...env },
});

function lastJson(r, label) {
  if (r.status !== 0) throw new Error(`${label} failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

const closure = {};
for (const target of ['host', 'serve']) {
  const r = run(['scripts/module-closure-probe.mjs', target]);
  const out = lastJson(r, `closure ${target}`);
  closure[target] = {
    loadedModules: out.modules.length,
    webModules: out.modules.filter((m) => m.startsWith('web/')),
    threeModules: out.modules.filter((m) => /(^|\/)camp-3d-/.test(m)),
    webglModules: out.webgl,
  };
}

const measure = lastJson(run(['scripts/arch-async-probe.mjs', 'measure']), 'measure');
const crashDir = mkdtempSync(join(tmpdir(), 'arch-evidence-crash-'));
const crashRun = run(['scripts/arch-async-probe.mjs', 'crash'], { DATA_DIR: crashDir });
if (crashRun.status !== 1) throw new Error(`crash probe expected exit 1, got ${crashRun.status}: ${crashRun.stderr}`);
const { loadCamp, readIndex, validCampArchive } = await import('../life/camp-instances.mjs');
const crashIndex = readIndex(crashDir);
const crashArchives = crashIndex.entries.map(({ key }) => {
  try {
    const raw = loadCamp(crashDir, key);
    return { key, t: raw.t, valid: validCampArchive(raw) };
  } catch (error) {
    return { key, valid: false, error: String(error?.message ?? error) };
  }
});
const crashMain = JSON.parse(readFileSync(join(crashDir, 'world.json'), 'utf8'));
// 重启恢复：同一 DATA_DIR 装回世界，逐营地打开。
Object.assign(process.env, {
  DATA_DIR: crashDir, SEED_FILE: join(crashDir, 'missing-seed.json'),
  GAME_MODE: 'game', TICK_MS: '1000000', ACT_SAVE_COALESCE_MS: '0', BRAIN: 'local',
});
const { host } = await import('../life/host.mjs');
await host.start();
const reopened = [];
try {
  for (const { key } of crashIndex.entries) {
    const view = await host.readWorld('menu', key);
    reopened.push({ key, ok: view.camp?.key === key, t: view.survival?.t ?? null });
  }
} finally {
  host.stop();
}

const evidence = {
  head: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(),
  harness: 'node scripts/arch-async-probe.mjs measure | crash',
  closure: {
    assertion: '子进程真实 import host.mjs / serve.mjs，加载表不含 web/、camp-3d-*、WebGL',
    host: closure.host,
    serve: closure.serve,
    pass: Object.values(closure).every((row) => row.webModules.length === 0 && row.threeModules.length === 0 && row.webglModules.length === 0),
  },
  asyncPersistence: {
    camps: measure.camps,
    ticks: measure.ticks,
    injectedDiskStallMs: measure.stallMs,
    tick: measure.tick,
    flush: measure.flush,
    archives: measure.archives,
    tickDidNotAwaitDisk: measure.tickDidNotAwaitDisk,
    oldArchiveReadable: measure.archives.bakReadable,
    pass: measure.tickDidNotAwaitDisk && measure.archives.allValid && measure.flush.ok,
  },
  crashRecovery: {
    exitCode: crashRun.status,
    main: { t: crashMain.A?.world?.t ?? null, survivalT: crashMain.survival?.t ?? null },
    indexEntries: crashIndex.entries.length,
    archives: crashArchives,
    reopened,
    oldArchivesReadable: crashArchives.every((a) => a.valid),
    allReopened: reopened.every((r) => r.ok),
    pass: crashArchives.every((a) => a.valid) && reopened.every((r) => r.ok) && crashIndex.entries.length === 6,
  },
};
evidence.risks = [
  '异步 tick 存档在进程硬退出时可能丢最后一次已排但未落盘的 tick（可接受，flush/stop 会收口）。',
  '主营地 .bak 首次保存不存在，第二次保存起才有；旧档可读性实测以 .bak 与营地档为准。',
];
mkdirSync(join(ROOT, 'evidence', 'arch-fix'), { recursive: true });
writeFileSync(join(ROOT, 'evidence', 'arch-fix', 'multiproc-async.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ closure: evidence.closure.pass, async: evidence.asyncPersistence.pass, crash: evidence.crashRecovery.pass }));

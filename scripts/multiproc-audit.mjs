// 6 进程真实压测：同 DATA_DIR 并发 open/save；记录丢失/错误/耗时，写 evidence。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = process.cwd();
const DATA = mkdtempSync(join(tmpdir(), 'audit-mp-'));
const ROUNDS = Number(process.env.MP_ROUNDS ?? 8);
const N = 6;
const t0 = Date.now();
const runs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['life/multiproc-worker.mjs', String(i), String(ROUNDS)], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, SEED_FILE: join(ROOT, 'seed/world.json'), BRAIN: 'local', TICK_MS: '1000000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', () => {});
  p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ id: i, fail: ROUNDS, errors: ['WORKER_CRASH'] }); } });
})));
let index = { entries: [] };
try { index = JSON.parse(readFileSync(join(DATA, 'saves', 'index.json'), 'utf8')); } catch {}
const files = (() => { try { return readdirSync(join(DATA, 'saves')); } catch { return []; } })();
const out = { generatedAt: new Date().toISOString(), dataDir: DATA, workers: N, rounds: ROUNDS,
  expected: N * ROUNDS, indexEntries: index.entries?.length ?? 0, campFiles: files.filter((n) => /^[0-9a-f]{32}\.json\.gz$/.test(n)).length,
  ok: runs.reduce((a, r) => a + (r.ok ?? 0), 0), fail: runs.reduce((a, r) => a + (r.fail ?? 0), 0),
  errors: runs.flatMap((r) => r.errors ?? []), runs, elapsedMs: Date.now() - t0,
  lost: Math.max(0, N * ROUNDS - (index.entries?.length ?? 0)),
  pass: (runs.every((r) => (r.fail ?? 1) === 0) && (index.entries?.length ?? 0) === N * ROUNDS) };
writeFileSync('evidence/audit-fix/multiproc.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ expected: out.expected, index: out.indexEntries, ok: out.ok, fail: out.fail, lost: out.lost, pass: out.pass, ms: out.elapsedMs }));


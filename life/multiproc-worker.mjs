// 6 进程同 DATA_DIR 压测 worker：每个进程独立 open/save 固定轮数。
import { host, openCamp } from './host.mjs';
const id = process.argv[2] ?? '0';
const rounds = Number(process.argv[3] ?? 10);
let ok = 0, fail = 0; const errors = [];
await host.start();
for (let i = 0; i < rounds; i += 1) {
  try { const r = await openCamp(`proc${id}-${i}`); if (r?.ok) ok += 1; else { fail += 1; errors.push(r?.code ?? 'OPEN_FAIL'); } await host.save(); }
  catch (e) { fail += 1; errors.push(String(e?.code ?? e?.message ?? e).slice(0, 80)); }
}
host.stop();
console.log(JSON.stringify({ id, rounds, ok, fail, errors: errors.slice(0, 10) }));

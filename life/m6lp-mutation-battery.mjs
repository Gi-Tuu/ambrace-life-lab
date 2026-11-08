// M6-L 变异电池（PLAN §25.6 L5）：四条变异各自打红瞄准的闸门；对照必须全绿。
// 用法：node life/m6lp-mutation-battery.mjs > docs/evidence/m6-20261108/lp-mutation-battery.log
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const LIFE = fileURLToPath(new URL('.', import.meta.url));
const TEST = 'm6-lp.test.mjs';
const MUTATIONS = [
  { id: 'lp-m1 忽略开关', file: 'agent.mjs', from: 'exploreGate: ch.lpExplore ? this.lpProgress() : 0', to: 'exploreGate: 0', expect: ['L1 承重'] },
  { id: 'lp-m2 g恒1', file: 'agent.mjs', from: 'if (!this.lpSlow) return 0;', to: 'if (!this.lpSlow) return 1;', expect: ['L2 负控'] },
  { id: 'lp-m3 加成不进归因', file: 'model.mjs', from: 'if (exploreBonus) cand.探索 = Number(exploreBonus.toFixed(4));', to: 'if (false) cand.探索 = Number(exploreBonus.toFixed(4));', expect: ['L3 归因暴露'] },
  { id: 'lp-m4 默认关写反', file: 'model.mjs', from: 'lpExplore: 0', to: 'lpExplore: 1', firstOnly: true, expect: ['L4 默认关'] },
];

function run(dir) {
  try {
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, TEST)], { encoding: 'utf8', cwd: dir, timeout: 600000 });
    return { code: 0, failed: [], out };
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    return { code: e.status ?? 1, failed: [...out.matchAll(/not ok \d+ - (.+)/g)].map((m) => m[1].trim()), out };
  }
}

const root = mkdtempSync(join(tmpdir(), 'm6lp-battery-'));
let bad = 0;
const cdir = join(root, 'control');
cpSync(LIFE, cdir, { recursive: true });
const c = run(cdir);
console.log(`CONTROL ${TEST} exit=${c.code} failed=${c.failed.length}`);
if (c.code !== 0) { bad++; console.log(c.out.slice(-3000)); }
for (const m of MUTATIONS) {
  const dir = join(root, m.id.replace(/[^\w-]+/g, '_'));
  cpSync(LIFE, dir, { recursive: true });
  const f = join(dir, m.file);
  const src = readFileSync(f, 'utf8');
  const n = src.split(m.from).length - 1;
  if (n < 1 || (!m.firstOnly && n !== 1)) { console.log(`SKIP ${m.id} 锚点 ${n} 次`); bad++; continue; }
  writeFileSync(f, m.firstOnly ? src.replace(m.from, m.to) : src.replaceAll(m.from, m.to));
  const r = run(dir);
  const hit = m.expect.filter((g) => r.failed.some((x) => x.includes(g)));
  const ok = r.code !== 0 && hit.length === m.expect.length;
  if (!ok) bad++;
  console.log(`${ok ? 'RED-OK' : 'MISS  '} ${m.id} exit=${r.code} 打红=[${r.failed.join(' | ')}] 命中=${hit.length}/${m.expect.length}`);
}
console.log(bad === 0 ? 'BATTERY PASS：对照全绿，4 条变异各自打红瞄准的闸门' : `BATTERY FAIL：${bad} 处不符合预期`);
process.exit(bad === 0 ? 0 : 1);

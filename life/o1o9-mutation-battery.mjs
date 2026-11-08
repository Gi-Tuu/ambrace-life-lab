// O1-M / O9-M 变异电池（补 PLAN §23.5/§23.7 声称但缺 artifact 的那份证据）。
// 做法与 M4 的 m4-mutation-battery 同口径：把 life/ 复制到临时目录，施加一条源码变异，
// 跑对应闸门文件，记录哪些闸门变红；期望每条变异至少打红它瞄准的闸门。
// 先跑未变异对照（两份闸门文件在复制树里必须全绿），否则电池本身无效。
// 用法：node life/o1o9-mutation-battery.mjs > docs/evidence/o9m-20261108/mutation-battery.log
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const LIFE = fileURLToPath(new URL('.', import.meta.url));
const O1 = 'o1-counterfactual.test.mjs';
const O9 = 'o9-event-first.test.mjs';

// expect 用闸门名的子串匹配 TAP 的 "not ok N - <name>"
const MUTATIONS = [
  { id: 'o1-m1 usage忽略开关', file: 'viability.mjs', from: 'const useCf = cf && decisions > 0 && sum > 0;', to: 'const useCf = false;', test: O1, expect: ['C2b 选择跟踪'] },
  { id: 'o1-m2 测量没接', file: 'agent.mjs', from: 'if (ch.cfUsage) this.noteInfluence(', to: 'if (false) this.noteInfluence(', test: O1, expect: ['C1 同量纲', 'C2 装置交叉核对', 'C2b 选择跟踪', 'C1 影子路径'] },
  { id: 'o1-m3 零测量不兜底', file: 'viability.mjs', from: 'const useCf = cf && decisions > 0 && sum > 0;', to: 'const useCf = cf;', test: O1, expect: ['C3 零影响度'] },
  { id: 'o1-m4 D1绕过⑥', file: 'agent.mjs', from: 'damage: Boolean(this.ch.erosion)', to: 'damage: true', test: O1, expect: ['C4 D1'] },
  { id: 'o1-m5 影子不中性化', file: 'agent.mjs', from: 'this.relations = { get: () => ({ familiarity: 0, trust: 50 }) };', to: 'this.relations = realRel;', test: O1, expect: ['C1 影子路径'] },
  { id: 'o1-m6 中性值写成30', file: 'agent.mjs', from: 'this.relations = { get: () => ({ familiarity: 0, trust: 50 }) };', to: 'this.relations = { get: () => ({ familiarity: 0, trust: 30 }) };', test: O1, expect: ['C1 关系自证'] },
  { id: 'o1-m7 默认关写反(cfUsage)', file: 'model.mjs', from: 'cfUsage: 0', to: 'cfUsage: 1', firstOnly: true, test: O1, expect: ['C5 默认关'] },
  { id: 'o1-m8 分母翻倍', file: 'agent.mjs', from: 'this.counters.cfDecisions = (this.counters.cfDecisions ?? 0) + 1;', to: 'this.counters.cfDecisions = (this.counters.cfDecisions ?? 0) + 2;', test: O1, expect: ['C2 装置交叉核对'] },
  { id: 'o9-m1 断开关', file: 'agent.mjs', from: '!(ch.eventFirst && reason)', to: 'true', test: O9, expect: ['E1 事件优先'] },
  { id: 'o9-m2 忽略开关', file: 'agent.mjs', from: '!(ch.eventFirst && reason)', to: '!reason', test: O9, expect: ['E1 负控', 'E2 默认关'] },
  { id: 'o9-m3 alarm改去home', file: 'agent.mjs', from: "{ when: (p) => p.kind === 'alarm', then: () => ({ kind: 'move_to', to: 'hall' }) },", to: "{ when: (p) => p.kind === 'alarm', then: () => ({ kind: 'move_to', to: 'home' }) },", test: O9, expect: ['E3 生存语义'] },
  { id: 'o9-m4 驳回不重问', file: 'agent.mjs', from: "const ask = Boolean(this.deliberator) && Boolean(ch.ask) && reason !== null;", to: "const ask = Boolean(this.deliberator) && Boolean(ch.ask) && reason !== null && reason !== '驳回重决策';", test: O9, expect: ['E5 不吞并'] },
  { id: 'o9-m5 默认关写反(eventFirst)', file: 'model.mjs', from: 'eventFirst: 0', to: 'eventFirst: 1', firstOnly: true, test: O9, expect: ['E2 默认关'] },
];

function run(test, dir) {
  try {
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, test)], { encoding: 'utf8', cwd: dir, timeout: 600000 });
    return { code: 0, failed: [], out };
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    return { code: e.status ?? 1, failed: [...out.matchAll(/not ok \d+ - (.+)/g)].map((m) => m[1].trim()), out };
  }
}

const root = mkdtempSync(join(tmpdir(), 'o1o9-battery-'));
let bad = 0;
for (const test of [O1, O9]) {
  const dir = join(root, `control-${test}`);
  cpSync(LIFE, dir, { recursive: true });
  const r = run(test, dir);
  console.log(`CONTROL ${test} exit=${r.code} failed=${r.failed.length}`);
  if (r.code !== 0) { bad++; console.log(r.out.slice(-3000)); }
}
for (const m of MUTATIONS) {
  const dir = join(root, m.id.replace(/[^\w-]+/g, '_'));
  cpSync(LIFE, dir, { recursive: true });
  const f = join(dir, m.file);
  const src = readFileSync(f, 'utf8');
  const n = src.split(m.from).length - 1;
  if (n < 1 || (!m.firstOnly && n !== 1)) { console.log(`SKIP ${m.id} 锚点出现 ${n} 次（要求 1）`); bad++; continue; }
  writeFileSync(f, m.firstOnly ? src.replace(m.from, m.to) : src.replaceAll(m.from, m.to));
  const r = run(m.test, dir);
  const hit = m.expect.filter((g) => r.failed.some((f2) => f2.includes(g)));
  const ok = r.code !== 0 && hit.length === m.expect.length;
  if (!ok) bad++;
  console.log(`${ok ? 'RED-OK' : 'MISS  '} ${m.id} exit=${r.code} 打红=[${r.failed.join(' | ')}] 期望命中=${hit.length}/${m.expect.length}`);
}
console.log(bad === 0 ? 'BATTERY PASS：对照全绿，13 条变异各自打红瞄准的闸门' : `BATTERY FAIL：${bad} 处不符合预期`);
// 历史弱点已修（F2，PLAN §26）：E2 第三断言改为同种子臂比较；o9-m2（no-op 开关）现在必须打红 E2。
// 旧弱点记录保留在 PLAN §24.2：simulate 把 channelMask 哈希进每角色种子，mask 两档的"轨迹必须不同"曾恒真。
console.log('NOTE E2 已按 F2 改为同种子臂；o9-m2 期望打红 E1负控+E2（旧恒真弱点见 PLAN §24.2/§26）');
process.exit(bad === 0 ? 0 : 1);

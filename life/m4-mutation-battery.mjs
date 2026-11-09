// M4 变异电池（补 BUG-22：台账声称"14 条变异把闸门全打红"，但脚本从未入库、别人无法复核）。
// 口径与 life/o1o9-mutation-battery.mjs 完全一致：
//   1) 把 life/ 复制到临时目录；2) 先跑**未变异对照**，必须全绿（否则电池本身无效）；
//   3) 逐条施加源码变异，跑 coupling.test.mjs，要求 exit≠0 且**瞄准的闸门名出现在 TAP 的 not ok 里**；
//   4) 锚点没命中 = SKIP 且记失败（绝不静默跳过）。
// 用法：node life/m4-mutation-battery.mjs
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const LIFE = fileURLToPath(new URL('.', import.meta.url));
const TEST = 'coupling.test.mjs';

const MUTATIONS = [
  {
    id: 'm4-m1 τ 到期不回初值',
    file: 'coupling.mjs',
    from: '  tick(dt = 1) {',
    to: '  tick(dt = 1) { return;',
    expect: ['P6c'],
  },
  {
    id: 'm4-m2 闭门对世界无效',
    file: 'coupling.mjs',
    from: 'export const reachableOf = (agent) => (agent?.coupling ? agent.coupling.reachable() : true);',
    to: 'export const reachableOf = () => true;',
    expect: ['P6b 他人清单收缩'],
  },
  {
    id: 'm4-m3 输入增益断开',
    file: 'agent.mjs',
    from: 'const gain = this.ch.coupling && !world.couplingGainOff ? this.coupling.input : 1;',
    to: 'const gain = 1;',
    expect: ['P6a/①'],
  },
  {
    id: 'm4-m4 缓解标价不再进评价目标',
    file: 'appraisal.mjs',
    from: 'TARGETS[kind] = { ...TARGETS.relocate, arousal: Number(arousalTargetFromRelief(eff.relief).toFixed(6)) };',
    to: 'TARGETS[kind] = { ...TARGETS.relocate };',
    expect: ['A2'],
  },
  {
    id: 'm4-m5 耦合动作不进候选清单',
    file: 'body.mjs',
    from: 'if (me?.ch?.coupling && world.couplingActions !== false) {',
    to: 'if (false) {',
    expect: ['P6a 三条动作'],
  },
  {
    id: 'm4-m6 拒绝不再挡住对话',
    file: 'body.mjs',
    from: 'if (other?.coupling?.refuses()) {',
    to: 'if (false) {',
    expect: ['P6b 拒绝是世界侧的'],
  },
  {
    // 默认关（channelsFor 里 coupling:0）由 life.test.mjs 与 host-layers.test.mjs 守，
    // 不在 coupling.test.mjs 里 ⇒ 本电池换成一条它真的守的变异：
    // 把"初值是听得进/找得到"改成"预设闭门"，看负控那一侧会不会塌。
    id: 'm4-m7 初值不再是"听得进/找得到"',
    file: 'coupling.mjs',
    from: 'export const COUPLING_DEFAULT = Object.freeze({ input: 1, available: 1, refuse: 0 });',
    to: 'export const COUPLING_DEFAULT = Object.freeze({ input: 1, available: 0, refuse: 0 });',
    expect: ['P6a 三条动作'],
  },
];

function run(dir) {
  try {
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, TEST)], { encoding: 'utf8', cwd: dir, timeout: 900000, maxBuffer: 128 * 1024 * 1024 });
    return { code: 0, failed: [], out };
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    return { code: e.status ?? 1, failed: [...out.matchAll(/not ok \d+ - (.+)/g)].map((m) => m[1].trim()), out };
  }
}

const root = mkdtempSync(join(tmpdir(), 'm4-battery-'));
const base = join(root, 'life');
cpSync(LIFE, base, { recursive: true });

const ctrl = run(base);
if (ctrl.code !== 0) {
  console.error('对照（未变异）不全绿，电池无效：', ctrl.failed.slice(0, 5));
  process.exit(1);
}
console.log(`对照：${TEST} 全绿（未变异）`);

let bad = 0;
for (const m of MUTATIONS) {
  const dir = mkdtempSync(join(root, 'm-'));
  cpSync(base, dir, { recursive: true });
  const f = join(dir, m.file);
  const src = readFileSync(f, 'utf8');
  if (!src.includes(m.from)) {
    console.log(`SKIP   ${m.id}：锚点没命中（源码已变，电池必须跟着改，不能静默跳过）`);
    bad += 1;
    continue;
  }
  writeFileSync(f, m.firstOnly ? src.replace(m.from, m.to) : src.split(m.from).join(m.to), 'utf8');
  const r = run(dir);
  const hit = m.expect.filter((name) => r.failed.some((x) => x.includes(name)));
  const ok = r.code !== 0 && hit.length === m.expect.length;
  if (!ok) bad += 1;
  const red = r.failed.slice(0, 3).join(' | ').slice(0, 150);
  console.log(`${ok ? 'RED-OK' : 'BAD   '} ${m.id} exit=${r.code} 打红=[${red}] 期望命中=${hit.length}/${m.expect.length}`);
}

console.log(bad === 0 ? 'BATTERY PASS：对照全绿，每条变异都打红了瞄准的闸门' : `BATTERY FAIL：${bad} 条没通过`);
process.exit(bad === 0 ? 0 : 1);

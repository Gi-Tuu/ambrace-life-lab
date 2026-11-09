// 静态检查（零依赖，全部用 Node 内建能力）：
//   1) 语法：对每个 .mjs/.js 跑 `node --check`
//   2) 依赖图：每个相对 import 必须解析到真实文件
//   3) 数据文件：所有 JSON 必须能解析
//   4) 引擎纪律：库层不许 console.log（会撞 node --test 的子进程消息通道，本仓库踩过）；
//      非测试模块不许用 Math.random（随机必须走 rng.mjs，否则轨迹不可复现）
//   5) 测试纪律：不许 .only（会静默跳过同文件其它用例）；每个测试文件至少有一条 test()
// 用法：node scripts/check.mjs   （失败时退出码 1）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rel = (p) => p.split(sep).join('/');
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

const problems = [];
const fail = (msg) => problems.push(msg);

// 1) 语法
const sources = [
  ...walk(join(ROOT, 'life')).filter((f) => f.endsWith('.mjs')),
  ...walk(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')),
  ...walk(join(ROOT, 'web')).filter((f) => f.endsWith('.js')),
  join(ROOT, 'serve.mjs'),
];
let checked = 0;
for (const f of sources) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  checked += 1;
  if (r.status !== 0) fail(`语法检查失败 ${rel(f).replace(rel(ROOT) + '/', '')}: ${String(r.stderr).split('\n')[0]}`);
}

// 2) 相对 import 解析
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) fail(`${rel(f).replace(rel(ROOT) + '/', '')} 的 import 解析不到文件：${m[1]}`);
  }
}

// 3) JSON 可解析
const jsons = [
  join(ROOT, 'package.json'),
  join(ROOT, 'seed', 'world.json'),
  join(ROOT, 'm3-imported-hashes.json'),
  ...walk(join(ROOT, 'packs')).filter((f) => f.endsWith('.json')),
  ...walk(join(ROOT, 'web', 'assets')).filter((f) => f.endsWith('.json')),
  ...walk(join(ROOT, 'life')).filter((f) => f.endsWith('.json')),
];
for (const f of jsons) {
  try { JSON.parse(readFileSync(f, 'utf8')); } catch (e) { fail(`JSON 解析失败 ${rel(f).replace(rel(ROOT) + '/', '')}: ${e.message}`); }
}

// 4) 引擎纪律
const ENGINE = ['host', 'agent', 'body', 'model', 'rules', 'memory', 'viability', 'coupling',
  'drives', 'appraisal', 'relations', 'clock', 'presets', 'speech', 'gossip', 'social',
  'params', 'rng', 'traits', 'modulators', 'm3-planner', 'm5-bank', 's4-predictor'];
// 注：life/run.mjs 是「库 + CLI」双身份（导出 simulate 给测试，同时打印表格给命令行），
// 它的 console.log 是被 if (process.argv[1]?.endsWith('run.mjs')) 门控的，不算库层泄露。
// 同一类的还有各 *_sweep/probe/eval 测量脚本——它们是命令行装置，允许打印。
for (const name of ENGINE) {
  const f = join(ROOT, 'life', `${name}.mjs`);
  if (!existsSync(f)) continue;
  const text = readFileSync(f, 'utf8');
  if (/console\.log\(/.test(text)) fail(`库层泄露到 stdout：life/${name}.mjs 含 console.log（会让 node --test 报 Unable to deserialize cloned data）`);
  if (/Math\.random\(/.test(text)) fail(`引擎里出现 Math.random：life/${name}.mjs（随机必须走 rng.mjs，否则同种子不可复现）`);
}

// 5) 测试纪律
const testFiles = readdirSync(join(ROOT, 'life')).filter((f) => f.endsWith('.test.mjs'));
const allowRandom = new Set(['serve-guard.test.mjs', 'frontend.test.mjs']); // 只为挑一个空闲端口
if (!testFiles.length) fail('life/ 下没有任何 *.test.mjs');
for (const name of testFiles) {
  const f = join(ROOT, 'life', name);
  const text = readFileSync(f, 'utf8');
  if (/\.only\(/.test(text)) fail(`life/${name} 含 .only( ⇒ 会静默跳过同文件其它用例`);
  if (!/\btest\(/.test(text)) fail(`life/${name} 里没有 test( 调用`);
  if (/Math\.random\(/.test(text) && !allowRandom.has(name)) fail(`life/${name} 用了 Math.random（测试也应当可复现）`);
}

// 汇总
if (problems.length) {
  console.error(`✖ 静态检查失败：${problems.length} 项`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✔ 静态检查通过：语法 ${checked} 个文件 · import 图已解析 · JSON ${jsons.length} 份 · 引擎纪律 ${ENGINE.length} 个模块 · 测试文件 ${testFiles.length} 个`);

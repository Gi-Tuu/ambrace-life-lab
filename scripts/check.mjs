// 静态检查（零依赖，全部用 Node 内建能力）：
//   1) 语法：对每个 .mjs/.js 跑 `node --check`
//   2) 依赖图：每个相对 import 必须解析到真实文件
//   3) 数据文件：所有 JSON 必须能解析
//   4) 引擎纪律：库层不许 console.log（会撞 node --test 的子进程消息通道，本仓库踩过）；
//      非测试模块不许用 Math.random（随机必须走 rng.mjs，否则轨迹不可复现）
//   5) 测试纪律：不许 .only（会静默跳过同文件其它用例）；每个测试文件至少有一条 test()
//   6) 入口真 import() 一遍（抓 node --check 漏报的尾部语法错）
//   7) 架构闸门（scripts/arch-gates.mjs 的规则表）
//   8) 仓库卫生：被跟踪却同时被 .gitignore 命中的文件不得新增，遗留登记也不许腐烂
//   9) 判据 ID：life/*.test.mjs 里 test/describe/it 标题开头的编号必须全仓唯一；
//      重复即红并打印“重复 ID + 文件:行 + 测试名”（口径见 scripts/test-ids.mjs 文件头）
// 用法：node scripts/check.mjs   （失败时退出码 1）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { archGateReport } from './arch-gates.mjs';
import { scanTestIds } from './test-ids.mjs';

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

// web/ 下的 3D、音频、寻路都是 .mjs 真模块（app.js 只是入口）；只查 .js 会让 27 个模块逃过语法与 import 图检查。
// 1) 语法
const sources = [
  ...walk(join(ROOT, 'life')).filter((f) => f.endsWith('.mjs')),
  ...walk(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')),
  ...walk(join(ROOT, 'web')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')),
  join(ROOT, 'serve.mjs'),
];
let checked = 0;
// 语法检查默认每个文件 spawn 一个 `node --check`。Windows 上偶发子进程被安全软件拖住
// （单文件 30s+，465 个文件不可用）；`CHECK_INPROCESS=1 node --experimental-vm-modules scripts/check.mjs`
// 用同一 V8 解析器在进程内检查 ESM，语义等价、无子进程。
const INPROCESS = process.env.CHECK_INPROCESS === '1' && typeof vm.SourceTextModule === 'function';
for (const f of sources) {
  if (INPROCESS) {
    try {
      new vm.SourceTextModule(readFileSync(f, 'utf8'), { identifier: pathToFileURL(f).href });
    } catch (error) {
      fail(`语法检查失败 ${rel(f).replace(rel(ROOT) + '/', '')}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
    checked += 1;
    continue;
  }
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  checked += 1;
  if (r.status !== 0) fail(`语法检查失败 ${rel(f).replace(rel(ROOT) + '/', '')}: ${String(r.stderr).split('\n')[0]}`);
}
if (process.env.CHECK_INPROCESS === '1' && !INPROCESS) {
  fail('CHECK_INPROCESS=1 需要 --experimental-vm-modules（vm.SourceTextModule 不可用）');
}

// 2) 相对 import 解析
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) fail(`${rel(f).replace(rel(ROOT) + '/', '')} 的 import 解析不到文件：${m[1]}`);
  }
}

// 2b) 具名导入必须真的被导出（node --check 只查语法，抓不到 "does not provide an export named"）
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.{1,2}\/[^']+)'/g)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const target = resolve(dirname(f), m[2]);
    if (!existsSync(target)) continue; // 已在 2) 报过
    const t = readFileSync(target, 'utf8');
    if (/export\s+\*/.test(t)) continue; // 星号再导出：不在这里猜
    const exported = new Set();
    // 单声明：export function f / export class C / export const A = ...
    for (const e of t.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(e[1]);
    // const/let/var 可能有多个声明符（export const A=1, B=2;），逐个取；解构形态跳过，宁漏不误报
    for (const e of t.matchAll(/export\s+(?:const|let|var)\s+([^;\n]*)/g)) {
      const decl = e[1].trim();
      if (decl.startsWith('{') || decl.startsWith('[')) continue;
      for (const part of decl.split(',')) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(part);
        if (m) exported.add(m[1]);
      }
    }
    for (const e of t.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of e[1].split(',')) exported.add(n.trim().split(/\s+as\s+/).pop());
    if (/export\s+default/.test(t)) exported.add('default');
    for (const n of names) {
      if (!exported.has(n)) fail(`${rel(f).replace(rel(ROOT) + '/', '')} 从 ${m[2]} 导入了 ${n}，但那边没有导出它`);
    }
  }
}
// 2c) 被 life/ 引用的 web/*.mjs 不得使用浏览器 API（服务端会 import 它们，Node 里没有这些全局）
const serverShared = new Set();
for (const f of walk(join(ROOT, 'life')).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/from\s+'\.\.\/web\/[^']+'/g)) {
    serverShared.add(resolve(dirname(f), m[0].slice(6, -1)));
  }
}
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
for (const f of serverShared) {
  if (!existsSync(f)) { fail(`life/ 引用的 ${rel(f)} 不存在`); continue; }
  // Quoted part names are data. Keep bracketed globalThis access visible to this check.
  const body = stripComments(readFileSync(f, 'utf8')).replace(
    /(?:globalThis\s*\[\s*)?(?:'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*")/g,
    match => match.startsWith('globalThis') ? match : ' ');
  for (const api of ['document', 'window', 'localStorage', 'sessionStorage', 'navigator']) {
    if (new RegExp(`\\b${api}\\b`).test(body)) {
      fail(`${rel(f).replace(rel(ROOT) + '/', '')} 被 life/ 引用，却用了浏览器 API '${api}'（服务端 import 时会炸）`);
    }
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
const allowRandom = new Set(['serve-guard.test.mjs', 'frontend.test.mjs', 'brain-relay-routes.test.mjs']); // 只为挑一个空闲端口
if (!testFiles.length) fail('life/ 下没有任何 *.test.mjs');
for (const name of testFiles) {
  const f = join(ROOT, 'life', name);
  const text = readFileSync(f, 'utf8');
  if (/\.only\(/.test(text)) fail(`life/${name} 含 .only( ⇒ 会静默跳过同文件其它用例`);
  if (!/\btest\(/.test(text)) fail(`life/${name} 里没有 test( 调用`);
  if (/Math\.random\(/.test(text) && !allowRandom.has(name)) fail(`life/${name} 用了 Math.random（测试也应当可复现）`);
}

// 6) 真 import() 一遍入口：package.json 没声明 type，含 import 的 web/app.js 会先按 CJS 解析、
//    再重探为 ESM；重探只报前半段，文件末尾的语法错会从 node --check 溜过去（第三轮实测）。
//    这里只接受"非语法错"的失败：ReferenceError: document/window is not defined 是预期（Node 没有浏览器环境）。
try {
  await import(pathToFileURL(join(ROOT, 'web', 'app.js')).href);
} catch (e) {
  const name = String(e?.name ?? '');
  if (name === 'SyntaxError') fail('web/app.js 真 import() 失败（语法错，node --check 可能漏报）：' + String(e?.message ?? e).slice(0, 160));
  else if (!(e instanceof ReferenceError)) fail('web/app.js 真 import() 抛出非预期错误：' + String(e?.message ?? e).slice(0, 160));
}

// 7) 架构闸门：把 P0/P1/P2/P2c 的审计结论钉成静态规则（scripts/arch-gates.mjs）。
//    规则表、白名单与逐条理由都在那个文件里；这里只负责汇总成 check 的失败项。
const arch = archGateReport();
for (const p of arch.problems) fail(p);

// 8) 仓库卫生：被跟踪却同时被 .gitignore 命中的文件（`git add -f` 的产物）不得新增。
//    背景：docs/ 在 .gitignore 第 14 行，但历史上已有 27 份内部文档被 force-add 进了公开仓；
//    2026-11-22 又冒出一份 QA 回报，才把这条约定钉成规则。遗留清单原样登记、不假装它不存在，
//    但**多一个就红**，并把补救写进消息；少一个也红——防止这份登记悄悄腐烂。
const IGNORED_TRACKED_LEGACY = new Set([
  'docs/PIXEL-EDITOR-使用说明.md',
  'docs/README.md',
  'docs/创作手记-v2.md',
  'docs/参赛-评分冲刺.md',
  'docs/回报-1.2-扩建室内-2026-11-21.md',
  'docs/回报-P0-主线整合-2026-11-19.md',
  'docs/回报-P1-2026-11-19.md',
  'docs/回报-P1b-2026-11-19.md',
  'docs/回报-P2-2026-11-19.md',
  'docs/回报-P2b-2026-11-19.md',
  'docs/回报-P2c-2026-11-20.md',
  'docs/回报-P2收口-2026-11-21.md',
  'docs/回报-P3-2026-11-20.md',
  'docs/回报-体验修复-音频-2026-11-21.md',
  'docs/回报-债务-台账测试-2026-11-20.md',
  'docs/回报-债务-地图-2026-11-20.md',
  'docs/回报-债务-性能-2026-11-20.md',
  'docs/回报-债务-时间-2026-11-20.md',
  'docs/回报-审计5修复-2026-11-18.md',
  'docs/回报-审计修复-2026-11-18.md',
  'docs/回报-收尾-2026-11-20.md',
  'docs/回报-架构闸门-2026-11-20.md',
  'docs/回报-评分拉满-2026-11-18.md',
  'docs/回报-部署冒烟-2026-11-20.md',
  'docs/文档状态-2026-11-21.md',
  'docs/设计-审计5剩余-2026-11-18.md',
  'docs/设计-审计遗留-2026-11-18.md',
]);
{
  const r = spawnSync('git', ['ls-files', '-i', '-c', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`仓库卫生检查需要 git（当前不可用）：${String(r.stderr || r.error || '').split('\n')[0].slice(0, 120)}`);
  } else {
    const now = r.stdout.split(/\r?\n/).filter(Boolean);
    for (const p of now.filter((x) => !IGNORED_TRACKED_LEGACY.has(x))) {
      fail(`仓库卫生：${p} 被跟踪却同时被 .gitignore 命中（多半是 git add -f）⇒ 内部文档会进公开仓。`
        + `补救：git rm --cached "${p}"（文件留在工作树，不删内容）`);
    }
    for (const p of [...IGNORED_TRACKED_LEGACY].filter((x) => !now.includes(x))) {
      fail(`仓库卫生：遗留登记里的 ${p} 已不在"被跟踪且被忽略"集合里 ⇒ 请同步删掉这一行登记，别让它悄悄腐烂`);
    }
  }
}

// 9) 判据 ID 唯一性：测试标题开头的编号是判据的对外名字，重复会让“V4-09 指哪条”
//    这类歧义无法从测试名自证。这里不设基线棘轮：历史重复也一并要求清零，
//    新增重复与遗留重复走同一条红/绿线（交接文档里 141 个重复 ID 的债务即由此收口）。
//    抽取口径（大小写、区间、`P1a` 与 `P1` 的区分、只认标题开头）见 scripts/test-ids.mjs。
const idScan = scanTestIds(ROOT);
if (idScan.files === 0) fail('判据 ID 检查：life/ 下没有发现 *.test.mjs');
else if (idScan.withId === 0) fail('判据 ID 检查：没有任何标题带判据 ID（抽取口径可能失效）');
for (const group of idScan.duplicates) {
  fail(`判据 ID 重复：${group.id} 被 ${group.entries.length} 条测试共用 ⇒ 判据名不再唯一。`
    + '同一要求多夹具请加场景后缀（如 -SAVE/-OPEN），不同要求请按域改前缀（如 FAM-/REACH-）；'
    + '禁止只加无语义数字后缀。出现位置：');
  for (const entry of group.entries) fail(`  ${group.id}  ${entry.file}:${entry.line}  ${entry.title}`);
}

// 汇总
if (problems.length) {
  console.error(`✖ 静态检查失败：${problems.length} 项`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✔ 静态检查通过：语法 ${checked} 个文件 · import 图已解析 · JSON ${jsons.length} 份 · 引擎纪律 ${ENGINE.length} 个模块 · 测试文件 ${testFiles.length} 个 · 判据 ID ${idScan.uniqueIds} 个全仓唯一 · 架构闸门 ${arch.scanned} 文件/${arch.allowed.length} 白名单`);

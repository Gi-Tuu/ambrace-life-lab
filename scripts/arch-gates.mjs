// 架构闸门（零依赖）：把审计结论固化成静态规则，而不是只留在回报里。
//   ARCH-2D-01   退役的 2D 烘焙/渲染符号不得回流（P0 删烘焙、P3 清 2D 符号）；
//   ARCH-STEP-01 peripheralStepCap 只能留在 web/app.js 的 legacy fallback 分支，
//                正式 spaceMove 路径必须用 playerGameStep/playerStepCap（P2）；
//   ARCH-POS-01  位置字段只允许由白名单模块整字段写入（P2c：actor.pos 是唯一事实）。
// 用法：
//   node scripts/arch-gates.mjs                 单独跑，失败退出码 1
//   import { archGateReport } from './arch-gates.mjs'   由 scripts/check.mjs 汇总
// 每条问题都带 file:line + 规则名。白名单逐条写清“为什么可以留”，不按整文件放行。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const RULES = [
  { id: 'ARCH-2D-01', title: '退役的 2D 烘焙/渲染符号不得回流' },
  { id: 'ARCH-STEP-01', title: 'peripheralStepCap 只能留在 legacy fallback 分支' },
  { id: 'ARCH-POS-01', title: '位置字段只能由白名单模块整字段写入' },
  { id: 'ARCH-CLOCK-01', title: '正式模块不得把 world.t 当可写事实（派生时钟唯一）' },
];

// 运行路径 = 会随应用/服务端一起加载的目录 + 入口。测试、文档、证据、实验目录整体排除。
const RUNTIME_PREFIXES = ['life/', 'web/', 'shared/', 'scripts/'];
const RUNTIME_FILES = ['serve.mjs'];
const EXCLUDED_SEGMENTS = new Set([
  'docs', 'evidence', '.git', 'node_modules', '.agents', 'experiments', 'experiment',
]);
const TEST_RE = /\.(?:test|spec)\.(?:mjs|js|cjs)$/;
// 本文件保存的正是被禁止的符号表；不把闸门自己当违规（测试另有 fixture 验证规则能变红）。
const SELF = 'scripts/arch-gates.mjs';

const toPosix = (p) => p.split(sep).join('/');

const excluded = (relPath) =>
  relPath.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg));

const isRuntimePath = (relPath) =>
  !excluded(relPath)
  && relPath !== SELF
  && !TEST_RE.test(relPath)
  && (RUNTIME_PREFIXES.some((prefix) => relPath.startsWith(prefix)) || RUNTIME_FILES.includes(relPath));

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (EXCLUDED_SEGMENTS.has(name)) continue;
      walk(abs, out);
    } else {
      out.push(abs);
    }
  }
}

function readRuntimeFiles(root) {
  const absFiles = [];
  for (const prefix of RUNTIME_PREFIXES) {
    const dir = join(root, prefix.slice(0, -1));
    if (existsSync(dir)) walk(dir, absFiles);
  }
  for (const name of RUNTIME_FILES) {
    const abs = join(root, name);
    if (existsSync(abs)) absFiles.push(abs);
  }
  return absFiles
    .map((abs) => ({ path: toPosix(relative(root, abs)), text: readFileSync(abs, 'utf8') }))
    .filter(({ path }) => isRuntimePath(path));
}

// ── ARCH-2D-01 ────────────────────────────────────────────────────────────────
// 符号表来自 P0/P3 审计。`uGround` 在 P3 已改名为 `uRegionAtlas`，这里仍保留禁令，
// 防止旧 2D 底图 sampler 以同名回流。
const RETIRED_2D = [
  { re: /\bpaintTerrain\b/, why: 'P0 已删 2D 地形烘焙；地表分类只能走 terrainKinds()' },
  { re: /\bgroundPixels\b/, why: 'P0 已删整张世界像素缓冲；地面只能来自 regionAtlas' },
  { re: /\buGround\b/, why: 'P3 已把地面 sampler 改名为 uRegionAtlas；uGround 是退役的 2D 底图' },
  { re: /\buWater\b/, why: 'P3 已删水掩码分支（river/basin 由 region 数据判定）' },
  { re: /\bview\s*===\s*['"]2d['"]/, why: 'P0 已删 ?view=2d 单入口，运行时只允许 3D' },
  { re: /[?&]view=2d\b/, why: 'P0 已删 ?view=2d 单入口，运行时只允许 3D' },
  { re: /\bTIME_WAIT\b/, why: 'P1 正式连续时钟路径不设 TIME_WAIT 拒绝', allow: true },
];

// 旧超时码白名单：只允许研究态隔离模块里的那一个常量定义。
// 正式路径（world.simClock 打开）已在 resident-time/survplay-actions 的连续分支直接返回，
// 不再产生这个 code；host/host-world/survplay 编排层也不得 import research-time.mjs。
const TIME_WAIT_LEGACY = [
  {
    path: 'life/research-time.mjs',
    re: /export const LEGACY_TIME_CODE = 'TIME_WAIT';/,
    why: '研究态旧时间模型（!world.simClock）的唯一隔离点；正式路径必须为 0',
  },
];

const STEP_DEF = /function\s+peripheralStepCap\s*\(/;
const STEP_FORMAL_CONTEXT = /\bspaceMove\b|\bplayerGameStep\b/;
const STEP_LEGACY_GUARD = /\bif\s*\(\s*spaceMove\s*\)/;
const STEP_LEGACY_CALL = /!inCamp\(/;

// ── ARCH-CLOCK-01 ────────────────────────────────────────────────────────────
// 正式世界（world.simClock 存在）的 `t` 是 floor(nowMinutes/60) 的派生读法。
// 这些模块是正式时间轴/结算的承载者，不得再写 `world.t =` / `w.t =`（写 = 重锚时钟）。
// 存档/旧档迁移（survplay-save.mjs）与 A/B 研究包（host-world 的 p.world）不在集合内。
const CLOCK_FORMAL = new Set([
  'life/sim-clock.mjs', 'life/survplay.mjs', 'life/resident-time.mjs', 'life/survplay-actions.mjs',
  'life/survplay-camp.mjs', 'life/agent.mjs', 'life/dialogue.mjs', 'life/camp-play.mjs',
  'life/host-replay.mjs', 'life/host.mjs', 'life/host-model.mjs',
]);
const CLOCK_WRITE = /\b(?:world|w|sp\.world)\.t\s*=(?!=)/;

// ── ARCH-POS-01 ──────────────────────────────────────────────────────────────
// 唯一事实是 w.pos；loc/occupancy/playerPos/residentTravel/districtTravel 都是派生索引。
// 正则按任务口径锚定整字段直接赋值（`w.loc =`），不会误报 `t.loc` 施工任务或 `w.loc.p1 =`。
const POS_WRITE = /\b(?:w|world|s|fresh|state)\.(?:loc|occupancy|playerPos|residentTravel|districtTravel)\s*=(?!=)/;
const POS_ALLOW = new Map([
  ['life/actor-pos.mjs', { why: '唯一位置写入口：pos 与派生索引在同一事务里同步' }],
  ['life/survplay-save.mjs', { why: '旧档迁移：没有 pos 的历史存档按 loc/playerPos 补齐' }],
  ['life/host-world.mjs', { why: '研究/城镇快照恢复：不是 survival 存档，也没有 w.pos' }],
  ['life/camp-instances.mjs', { why: 'forkCamp 的 survival 夹具：离线构造玩家位置' }],
  ['life/build-efficiency.mjs', { why: '离线消融夹具：直接构造 occupancy' }],
  // m3-planner 的 `s` 是 planner 的动作对象（ActionState.loc），不是世界/居民位置。
  // 只对 `s.loc =` 放行；同一文件若出现 w/world/fresh/state 的位置写入仍然红。
  ['life/m3-planner.mjs', {
    why: 's 是 planner 的 ActionState（动作目标地点），不是世界/居民位置',
    only: /\bs\.loc\s*=(?!=)/,
  }],
]);

function snippet(line) {
  const text = line.trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function problem(rule, path, lineNo, line, why) {
  return `${path}:${lineNo}: [${rule}] ${why}（命中 \`${snippet(line)}\`）`;
}

/**
 * 跑三条架构闸门。
 * @param {{ root?: string, files?: Iterable<[string,string]> | Array<{path:string,text:string}> }} [options]
 *   files 只给测试用：传虚拟文件表，不读磁盘；路径仍按运行路径规则过滤。
 * @returns {{ problems: string[], allowed: Array<{rule:string,path:string,line:number,why:string}>, scanned: number }}
 */
export function archGateReport({ root = ROOT, files } = {}) {
  const sources = files
    ? [...files].map((item) => Array.isArray(item) ? { path: toPosix(item[0]), text: item[1] } : item)
      .filter(({ path }) => isRuntimePath(path))
    : readRuntimeFiles(root);
  const problems = [];
  const allowed = [];

  for (const { path, text } of sources) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNo = i + 1;

      for (const rule of RETIRED_2D) {
        if (!rule.re.test(line)) continue;
        if (rule.allow) {
          const entry = TIME_WAIT_LEGACY.find((item) => item.path === path && item.re.test(line));
          if (entry) {
            allowed.push({ rule: 'ARCH-2D-01', path, line: lineNo, why: entry.why });
            continue;
          }
        }
        problems.push(problem('ARCH-2D-01', path, lineNo, line, rule.why));
      }

      if (/\bperipheralStepCap\b/.test(line)) {
        if (path !== 'web/app.js') {
          problems.push(problem('ARCH-STEP-01', path, lineNo, line, 'peripheralStepCap 只允许留在 web/app.js 的 legacy fallback'));
        } else if (STEP_DEF.test(line)) {
          allowed.push({ rule: 'ARCH-STEP-01', path, line: lineNo, why: 'legacy fallback 的唯一实现，正式路径用 playerGameStep/playerStepCap' });
        } else {
          const guard = STEP_LEGACY_GUARD.test(lines[i - 1] ?? '') || STEP_LEGACY_GUARD.test(lines[i - 2] ?? '');
          if (STEP_FORMAL_CONTEXT.test(line)) {
            problems.push(problem('ARCH-STEP-01', path, lineNo, line, '正式 spaceMove/playerGameStep 路径不得使用 legacy peripheralStepCap'));
          } else if (!STEP_LEGACY_CALL.test(line) || !guard) {
            problems.push(problem('ARCH-STEP-01', path, lineNo, line, '不在 legacy fallback 分支（缺 !inCamp 调用或 if (spaceMove) 前置守卫）'));
          } else {
            allowed.push({ rule: 'ARCH-STEP-01', path, line: lineNo, why: 'legacy fallback：if (spaceMove) 之前的 else 分支，村外旧快照才走' });
          }
        }
      }

      if (POS_WRITE.test(line)) {
        const entry = POS_ALLOW.get(path);
        if (entry && (!entry.only || entry.only.test(line))) {
          allowed.push({ rule: 'ARCH-POS-01', path, line: lineNo, why: entry.why });
        } else {
          problems.push(problem('ARCH-POS-01', path, lineNo, line, '位置字段只能由 actor-pos.mjs 等白名单模块整字段写入（w.pos 是唯一事实）'));
        }
      }

      if (CLOCK_FORMAL.has(path) && CLOCK_WRITE.test(line)) {
        problems.push(problem('ARCH-CLOCK-01', path, lineNo, line, '正式模块不得写 world.t：它是 simClock 的派生整数，时间只经 advanceMinutes/setGameMinutes 推进'));
      }
    }
  }

  return { problems, allowed, scanned: sources.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = archGateReport();
  for (const item of report.allowed) {
    console.log(`  · 白名单 ${item.path}:${item.line}: [${item.rule}] ${item.why}`);
  }
  if (report.problems.length) {
    console.error(`✖ 架构闸门失败：${report.problems.length} 项`);
    for (const item of report.problems) console.error(`  - ${item}`);
    process.exit(1);
  }
  console.log(`✔ 架构闸门通过：扫描 ${report.scanned} 个运行路径文件 · ${RULES.length} 条规则 · 白名单 ${report.allowed.length} 处`);
}

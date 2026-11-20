// 架构闸门（零依赖）：把审计结论固化成静态规则，而不是只留在回报里。
//   ARCH-2D-01   退役的 2D 烘焙/渲染符号不得回流（P0 删烘焙、P3 清 2D 符号）；
//   ARCH-STEP-01 peripheralStepCap 已退役：正式路径村内/村外同一 speedBudget（P4 删回退分支）；
//   ARCH-SPACE-01 正式路径只走 life/space.mjs：旧空间开关/体半径包装/像素行走不得回流（P4）；
//   ARCH-POS-01  位置字段只允许由白名单模块整字段写入（P2c：actor.pos 是唯一事实）；
//   ARCH-RESEARCH-01 研究态旧行为只能是显式策略/legacy 配置行，不得复活第二套时钟或空间。
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
  { id: 'ARCH-STEP-01', title: 'peripheralStepCap 已退役：村内/村外只走同一 speedBudget' },
  { id: 'ARCH-SPACE-01', title: '正式路径只走 life/space.mjs：旧空间开关/包装/像素行走不得回流' },
  { id: 'ARCH-POS-01', title: '位置字段只能由白名单模块整字段写入' },
  { id: 'ARCH-CLOCK-01', title: '正式模块不得把 world.t 当可写事实（派生时钟唯一）' },
  { id: 'ARCH-RESEARCH-01', title: '研究态旧行为只能是显式策略/legacy 配置行，不得复活第二套时钟或空间' },
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

// 旧超时码白名单：只允许研究态策略模块里的那一个常量定义。
// 正式路径（world.simClock 打开）已在 resident-time/survplay-actions 的连续分支直接返回，
// 不再产生这个 code；host/host-world/survplay 编排层也不得 import research-policy.mjs。
const TIME_WAIT_LEGACY = [
  {
    path: 'life/research-policy.mjs',
    re: /export const LEGACY_TIME_CODE = 'TIME_WAIT';/,
    why: '研究态旧时间策略（!world.simClock）的唯一声明点；正式路径必须为 0',
  },
];

// ── ARCH-SPACE-01 ────────────────────────────────────────────────────────────
// 正式游戏只有一个空间权威：life/space.mjs。下面这些是 P2/P2b/P2c 期间的运行时开关与旧包装；
// P4 之后正式文件里出现任何一处都判红。退役实现以 legacy* 命名留在
// test-support/legacy-space-oracle.mjs（测试 oracle，运行路径 0 import）。
const SPACE_LEGACY = [
  { re: /\bSPACE_V1\b/, why: '服务端旧地面回退开关已删除；地面谓词只有 constructionSpace().walkable' },
  { re: /\bspaceQueriesEnabled\b/, why: '空间开关函数已删除；正式路径没有“走 space / 走旧谓词”的分叉' },
  { re: /\b__SPACE_LEGACY__\b/, why: '宿主注入的客户端回退开关已删除' },
  { re: /space=legacy/, why: '客户端 URL 回退开关已删除；退役实现只在测试 oracle 里' },
  { re: /\bcampBodyWorld\b/, why: '每帧复制 world 再膨胀像素栅格的包装已删除；寻路索引 world.pathGrid 在构建期算一次' },
  { re: /\broomPixelWalk\b/, why: '房间像素行走已删除；室内移动只走 roomSurface（16×12 世界空间）' },
  { re: /\broomBodyFits\b/, why: '室内体半径像素判定已删除；只问 roomSurface.walkable(x,z,CAMP_BODY_RADIUS)' },
  { re: /\bmoveRoomFeet\b/, why: '房间像素级推进已删除；室内推进只走 moveRoomSurface' },
  { re: /\broomAllows\b/, why: '房间像素谓词已删除；室内可走性只由 roomSurface 回答' },
  { re: /\blegacyGroundQuery\b/, why: '旧服务端地面谓词只在 test-support oracle；运行路径不得回流' },
];

// ── ARCH-RESEARCH-01 ─────────────────────────────────────────────────────────
// 研究态旧行为只允许两种形态：
//   1) life/research-policy.mjs 的显式策略声明（tick 语义、4 动作 cap、TIME_WAIT、100 点池）；
//   2) life/space.mjs 的 LEGACY_RESEARCH_UNITS_PER_TICK 配置行（12/10/40）。
// 已退役的 research-time/research-space 模块不得复活；60/1440/12/10 也不得在别处另写一份。
const RESEARCH_RETIRED = [
  {
    re: /(?:from\s*|import\s*\(\s*)['"][^'"]*research-(?:time|space)\.mjs['"]/,
    why: '研究态旧模块已退役：时间策略在 research-policy.mjs，空间 oracle 在 test-support/（仅测试可 import）',
  },
  {
    re: /(?:from\s*|import\s*\(\s*)['"][^'"]*test-support\/legacy-space-oracle\.mjs['"]/,
    why: '测试 oracle 只许 life/*.test.mjs import；运行路径必须 0 import',
  },
  {
    re: /\b(?:TICK_MINUTES|DAY_MINUTES)\s*=\s*(?:60|1440)\b/,
    why: '60/1440 只能从 sim-clock 的 GAME_MINUTES_PER_HOUR/DAY 派生，不得复制第二套日长',
  },
  {
    re: /\bRESIDENT_UNITS_PER_TICK\s*=\s*12\b/,
    why: '研究态 12/刻是 space.mjs 的 legacy speed-budget 行，不得复制第二套预算',
  },
  {
    re: /\bPLAYER_UNITS_PER_TICK\s*=\s*10\b/,
    why: '研究态 10/刻是 space.mjs 的 legacy speed-budget 行，不得复制第二套预算',
  },
];

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
        problems.push(problem('ARCH-STEP-01', path, lineNo, line,
          'peripheralStepCap 已退役：正式路径村内/村外同一 speedBudget（playerGameStep/playerStepCap）'));
      }

      for (const rule of SPACE_LEGACY) {
        if (!rule.re.test(line)) continue;
        problems.push(problem('ARCH-SPACE-01', path, lineNo, line, rule.why));
      }

      for (const rule of RESEARCH_RETIRED) {
        if (!rule.re.test(line)) continue;
        problems.push(problem('ARCH-RESEARCH-01', path, lineNo, line, rule.why));
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

// ARCH 闸门测试：每条规则都要能变红，也要在白名单/测试/文档上保持静默。
// 直接调用 scripts/arch-gates.mjs 的纯函数接口（files 传虚拟文件表），不启动服务、不依赖 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';
import { archGateReport, RULES, ROOT } from '../scripts/arch-gates.mjs';

const run = (entries) => archGateReport({ files: entries });
const file = (path, text) => [path, text];

test('ARCH-GATE-00 当前仓库七条闸门全绿（基线不假红）', () => {
  const report = archGateReport({ root: ROOT });
  assert.deepEqual(report.problems, []);
  assert.ok(report.scanned > 100, `扫描文件数太少：${report.scanned}`);
  assert.ok(report.allowed.length > 0, '白名单一条都没命中，说明规则口径可能已漂移');
  assert.deepEqual(RULES.map((r) => r.id), ['ARCH-2D-01', 'ARCH-STEP-01', 'ARCH-SPACE-01', 'ARCH-POS-01', 'ARCH-CLOCK-01', 'ARCH-RESEARCH-01', 'ARCH-IMPORT-01']);
});

test('ARCH-2D-01 退役 2D 符号逐条能变红', () => {
  const cases = [
    ['web/app.js', 'function paintTerrain(g) {}\n'],
    ['web/app.js', 'const groundPixels = g.getImageData(0, 0, 1, 1).data;\n'],
    ['web/camp-3d-render.mjs', 'uniform sampler2D uGround, uFog;\n'],
    ['web/camp-3d-render.mjs', 'float water = texture2D(uWater, vUV).r;\n'],
    ['web/app.js', "if (view === '2d') draw2d();\n"],
    ['web/app.js', "if (view==='2d') draw2d();\n"],
    ['web/app.js', "const url = '/?view=2d';\n"],
    ['life/new-path.mjs', "return { ok: false, code: 'TIME_WAIT' };\n"],
  ];
  for (const [path, text] of cases) {
    const { problems } = run([file(path, text)]);
    assert.equal(problems.length, 1, `${text.trim()} 应当红一次：${JSON.stringify(problems)}`);
    assert.match(problems[0], /^[^\s]+:\d+: \[ARCH-2D-01\]/, problems[0]);
  }
});

test('ARCH-2D-01-TIME-WAIT TIME_WAIT 只放行研究态隔离模块，正式路径 0', () => {
  const legacy = run([
    file('life/research-policy.mjs', "export const LEGACY_TIME_CODE = 'TIME_WAIT';\n"),
  ]);
  assert.deepEqual(legacy.problems, []);
  assert.equal(legacy.allowed.length, 1);
  // 同样的字符串出现在正式文件的注释/代码/别的分支，都不得借用白名单。
  const moved = run([
    file('life/resident-time.mjs', "  return { ok: false, code: 'TIME_WAIT' };\n"),
    file('life/survplay-actions.mjs', "    if (left <= 1e-9) return failTime('TIME_WAIT', 'x');\n"),
    file('life/other.mjs', "  // TIME_WAIT\n"),
  ]);
  assert.equal(moved.problems.filter((p) => p.includes('ARCH-2D-01')).length, 3);
});

test('ARCH-CLOCK-01 正式模块写 world.t 即红，存档/研究夹具不误报', () => {
  const bad = run([
    file('life/survplay.mjs', '  w.t = Math.floor(minute / 60);\n'),
    file('life/host.mjs', '  world.t = 24;\n'),
    file('life/agent.mjs', '  sp.world.t = 1;\n'),
  ]);
  assert.equal(bad.problems.filter((p) => p.includes('ARCH-CLOCK-01')).length, 3);
  // 派生读法、局部变量、存档迁移都不是写入。
  assert.deepEqual(run([
    file('life/survplay.mjs', '  const tick = Math.floor(w.simClock.nowMinutes() / 60);\n'),
    file('life/host.mjs', '  const t = world.t;\n'),
    file('life/survplay-save.mjs', '  w.t = raw.t;\n'),
    file('life/host-world.mjs', '  p.world.t += 1;\n'),
  ]).problems, []);
});

test('ARCH-2D-01-EXCLUDE-TEST-DOCS 测试/文档/证据/实验目录不计入运行路径', () => {
  const { problems, scanned } = run([
    file('life/foo.test.mjs', 'paintTerrain(); groundPixels; uWater;\n'),
    file('docs/old.md', 'paintTerrain\n'),
    file('evidence/x.log', 'uGround\n'),
    file('experiments/probe.mjs', "view === '2d';\n"),
    file('web/app.js', 'const ok = 1;\n'),
  ]);
  assert.deepEqual(problems, []);
  assert.equal(scanned, 1, '只有 web/app.js 算运行路径');
});

test('ARCH-STEP-01 peripheralStepCap 已退役：任何运行路径出现即红', () => {
  for (const path of ['scripts/probe.mjs', 'web/app.js', 'web/player-move.mjs']) {
    const report = run([file(path, 'const step = peripheralStepCap(snapshot, dt);\n')]);
    assert.equal(report.problems.length, 1, `${path} 应红：${JSON.stringify(report.problems)}`);
    assert.match(report.problems[0], /\[ARCH-STEP-01\]/);
  }
  assert.deepEqual(run([file('web/app.js', 'const step = Math.min(step, playerStepCap(snapshot, dt));\n')]).problems, []);
});

test('ARCH-SPACE-01 旧空间开关/包装/房间像素行走逐条能变红，测试与 docs 不误报', () => {
  const cases = [
    ["export const spaceQueriesEnabled = () => true;\n", /spaceQueriesEnabled/],
    ["const q = process.env['SPACE_V1'];\n", /SPACE_V1/],
    ['if (globalThis.__SPACE_LEGACY__ === true) return null;\n', /__SPACE_LEGACY__/],
    ["const legacy = location.search.includes('space=legacy');\n", /space=legacy/],
    ['const map = campBodyWorld(world, true);\n', /campBodyWorld/],
    ['const pixels = roomPixelWalk(site);\n', /roomPixelWalk/],
    ['if (!roomBodyFits(site, cells, pixels, bounds, x, y)) return;\n', /roomBodyFits/],
    ['const [x,z] = moveRoomFeet(cells, x, y, dx, dz, pixels, fits, bounds);\n', /moveRoomFeet/],
    ['if (!roomAllows(cells, px, py, pixels, bounds)) return false;\n', /roomAllows/],
    ['const legacy = legacyGroundQuery({ mapSeed: 1 });\n', /legacyGroundQuery/],
  ];
  for (const [text, re] of cases) {
    const report = run([file('web/app.js', text)]);
    assert.equal(report.problems.length, 1, `${text.trim()} 应红：${JSON.stringify(report.problems)}`);
    assert.match(report.problems[0], /\[ARCH-SPACE-01\]/);
    assert.ok(re.test(report.problems[0]), report.problems[0]);
  }
  // 测试 oracle 用 legacy* 命名，不得被 \b 误伤；测试/文档/证据目录不参与。
  assert.deepEqual(run([file('test-support/legacy-space-oracle.mjs',
    'export function legacyCampBodyWorld(world) { return world; }\nexport function legacyMoveRoomFeet() {}\n')]).problems, []);
  assert.deepEqual(run([
    file('life/space.test.mjs', 'campBodyWorld; roomPixelWalk; SPACE_V1;\n'),
    file('docs/old.md', "space=legacy SPACE_V1 campBodyWorld\n"),
    file('evidence/x.log', 'roomPixelWalk\n'),
  ]).problems, []);
});

test('ARCH-POS-01 位置字段只允许白名单整字段写入', () => {
  for (const line of [
    '  w.playerPos = { x: 1, z: 2 };\n',
    '  world.districtTravel = {};\n',
    '  s.residentTravel = {};\n',
    '  fresh.loc = { p1: "hall" };\n',
    '  state.occupancy = {};\n',
  ]) {
    const { problems } = run([file('life/rogue.mjs', line)]);
    assert.equal(problems.length, 1, `${line.trim()} 应当红`);
    assert.match(problems[0], /\[ARCH-POS-01\]/);
  }
  // 白名单只放行精确行内容；测试文件不参与。
  assert.deepEqual(run([file('life/actor-pos.mjs', '  w.occupancy = ok\n')]).problems, []);
  assert.deepEqual(run([file('life/camp-instances.mjs', "  fresh.loc = { ...(fresh.loc ?? {}), p1: 'hall' };\n")]).problems, []);
  assert.deepEqual(run([file('life/rogue.test.mjs', '  w.playerPos = {};\n')]).problems, []);
  // 施工任务的 t.loc、以及派生索引的局部字段，不是“整字段写位置”，不得误报。
  assert.deepEqual(run([file('life/rogue.mjs', "  if (t.loc === 'yard') return;\n")]).problems, []);
  assert.deepEqual(run([file('life/rogue.mjs', '  w.loc.p1 = "hall";\n')]).problems, []);
  // m3-planner 的 s 是 ActionState，只放行精确行；同文件的 w 位置写入仍红。
  assert.deepEqual(run([file('life/m3-planner.mjs', "  else if(a.kind==='move_to'){s.loc=a.to;s.companions={};}\n")]).problems, []);
  const plannerRogue = run([file('life/m3-planner.mjs', '  w.playerPos = pos;\n')]);
  assert.equal(plannerRogue.problems.length, 1);
});

test('ARCH-POS-01-CONTENT-COUNT 白名单按内容+次数：换行仍绿、复制违规行/换文件/改内容即红', () => {
  const allowedLine = '  w.occupancy = ok\n';
  // 行号漂移（前面插 200 行）不影响判定；line 字段只是提示。
  const shifted = `${'\n'.repeat(200)}${allowedLine}`;
  const shiftedReport = run([file('life/actor-pos.mjs', shifted)]);
  assert.deepEqual(shiftedReport.problems, []);
  assert.equal(shiftedReport.allowed.length, 1);
  assert.equal(shiftedReport.allowed[0].line, 201, 'allowed 报告实际行号，而不是死绑配置行号');
  // 同一违规行复制第二处：第二处必须红。
  const duplicated = run([file('life/actor-pos.mjs', `${allowedLine}${allowedLine}`)]);
  assert.equal(duplicated.allowed.length, 1);
  assert.equal(duplicated.problems.length, 1);
  assert.match(duplicated.problems[0], /\[ARCH-POS-01\].*只允许 1 处/);
  // 换到另一个文件必须红。
  assert.equal(run([file('life/rogue.mjs', allowedLine)]).problems.length, 1);
  // 内容改一个字（换成 playerPos）必须红。
  assert.equal(run([file('life/actor-pos.mjs', '  w.playerPos = ok\n')]).problems.length, 1);
});

test('ARCH-IMPORT-01 运行路径 import *.test.mjs / test-support/* 即红；测试文件本身仍排除', () => {
  // 用拼接构造 fixture 文本：既避免测试源码本身被 static check 当成真实 import，也保持被测内容等价。
  const importFrom = (target) => `import${' { x }'}${' from '}${JSON.stringify(target)};\n`;
  const dynamicImport = (target) => `const m = await ${'import'}(${JSON.stringify(target)});\n`;
  const cases = [
    [importFrom('./helper.test.mjs'), /helper\.test\.mjs/],
    [importFrom('../test-support/fixtures.mjs'), /test-support/],
    [importFrom('./fixtures.spec.js'), /fixtures\.spec\.js/],
    [dynamicImport('./helper.test.mjs'), /helper\.test\.mjs/],
  ];
  for (const [text, re] of cases) {
    const report = run([file('life/runtime.mjs', text)]);
    assert.equal(report.problems.length, 1, `${text.trim()} 应红：${JSON.stringify(report.problems)}`);
    assert.match(report.problems[0], /\[ARCH-IMPORT-01\]/);
    assert.ok(re.test(report.problems[0]), report.problems[0]);
  }
  // 测试文件自身被排除；但运行路径 import 它就红（上面第一条已证明）。
  assert.deepEqual(run([file('life/helper.test.mjs', importFrom('../test-support/legacy-space-oracle.mjs'))]).problems, []);
  assert.deepEqual(run([file('life/runtime.mjs', importFrom('./helper.mjs'))]).problems, []);
});

test('ARCH-RESEARCH-01 研究态只许显式策略/legacy 配置：第二套时钟/空间常量逐条变红', () => {
  const cases = [
    ["const a = await import('./research-time.mjs');\n", /research-time/],
    ["const a = await import('./research-space.mjs');\n", /research-space/],
    ["const a = await import('../test-support/legacy-space-oracle.mjs');\n", /legacy-space-oracle/],
    ['const TICK_MINUTES = 60;\n', /TICK_MINUTES/],
    ['export const DAY_MINUTES = 1440;\n', /DAY_MINUTES/],
    ['export const RESIDENT_UNITS_PER_TICK = 12;\n', /RESIDENT_UNITS_PER_TICK/],
    ['export const PLAYER_UNITS_PER_TICK = 10;\n', /PLAYER_UNITS_PER_TICK/],
    ['const units = { resident: 12 };\n', /resident/],
    ['const units = { player: 10 };\n', /player/],
    ['const units = { playerSyncInCamp: 40 };\n', /playerSyncInCamp/],
    ['const RESEARCH_RESIDENT_ACTION_CAP = 4;\n', /RESIDENT_ACTION_CAP/],
    ['const RESEARCH_RESIDENT_CHAIN_MAX = 2;\n', /CHAIN_MAX/],
    ['return worldTick(sp, { think: true });\n', /think:\s*true/],
  ];
  for (const [text, re] of cases) {
    const report = run([file('life/rogue.mjs', text)]);
    assert.equal(report.problems.length, 1, `${text.trim()} 应红：${JSON.stringify(report.problems)}`);
    assert.match(report.problems[0], /\[ARCH-RESEARCH-01\]/);
    assert.ok(re.test(report.problems[0]), report.problems[0]);
  }
  // 数值只在 policy 声明；space.mjs 只保留兼容 re-export，从常量派生/测试 oracle 路径都不误伤。
  assert.deepEqual(run([
    file('life/research-policy.mjs', [
      'export const RESEARCH_TICK_MINUTES = GAME_MINUTES_PER_HOUR;',
      'export const RESEARCH_SPEED_UNITS_PER_TICK = Object.freeze({ resident: 12, player: 10, playerSyncInCamp: 40 });',
      'export const RESEARCH_TICK_POLICY = Object.freeze({ perTickThink: true });',
    ].join('\n') + '\n'),
    file('life/space.mjs', 'export const GAME_RESIDENT_UNITS_PER_TICK = unitsPerTick(\'walk\');\n'),
    file('test-support/legacy-space-oracle.mjs', "export const x = 1;\n"),
  ]).problems, []);
  // 测试文件不参与运行路径扫描，但运行路径 import 测试 oracle 仍然红。
  assert.deepEqual(run([file('life/foo.test.mjs', 'const TICK_MINUTES = 60;\n')]).problems, []);
});

test('每条问题都带 file:line + 规则名，便于直接定位', () => {
  const { problems } = run([
    file('web/app.js', '\n\nfunction paintTerrain() {}\n'),
    file('life/rogue.mjs', '\n  w.playerPos = {};\n'),
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^web\/app\.js:3: \[ARCH-2D-01\] /);
  assert.match(problems[1], /^life\/rogue\.mjs:2: \[ARCH-POS-01\] /);
});



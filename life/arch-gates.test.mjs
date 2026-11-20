// ARCH 闸门测试：每条规则都要能变红，也要在白名单/测试/文档上保持静默。
// 直接调用 scripts/arch-gates.mjs 的纯函数接口（files 传虚拟文件表），不启动服务、不依赖 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';
import { archGateReport, RULES, ROOT } from '../scripts/arch-gates.mjs';

const run = (entries) => archGateReport({ files: entries });
const file = (path, text) => [path, text];

test('ARCH-GATE-00 当前仓库三条闸门全绿（基线不假红）', () => {
  const report = archGateReport({ root: ROOT });
  assert.deepEqual(report.problems, []);
  assert.ok(report.scanned > 100, `扫描文件数太少：${report.scanned}`);
  assert.ok(report.allowed.length > 0, '白名单一条都没命中，说明规则口径可能已漂移');
  assert.deepEqual(RULES.map((r) => r.id), ['ARCH-2D-01', 'ARCH-STEP-01', 'ARCH-POS-01']);
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

test('ARCH-2D-01 TIME_WAIT 只对 legacy 三处放行，换文件/换分支仍红', () => {
  const legacy = run([
    file('life/resident-time.mjs', "  if (dayLeft + 1e-9 < cost) return { ok: false, code: 'TIME_WAIT' };\n"),
    file('life/survplay-actions.mjs', "    if (left <= 1e-9) return failTime('TIME_WAIT', '这一拍的时间用完了，等下一拍');\n"),
    file('life/agent.mjs', "  why: budget.code === 'TIME_WAIT' ? '这一天的时间用完了' : 'x',\n"),
  ]);
  assert.deepEqual(legacy.problems, []);
  assert.equal(legacy.allowed.length, 3);
  // 同样的字符串出现在别的文件，或同一文件的另一行，都不得借用白名单。
  const moved = run([
    file('life/other.mjs', "  if (dayLeft + 1e-9 < cost) return { ok: false, code: 'TIME_WAIT' };\n"),
    file('life/resident-time.mjs', "  if (cost > 0) return { ok: false, code: 'TIME_WAIT' };\n"),
  ]);
  assert.equal(moved.problems.filter((p) => p.includes('ARCH-2D-01')).length, 2);
});

test('ARCH-2D-01 测试/文档/证据/实验目录不计入运行路径', () => {
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

test('ARCH-STEP-01 peripheralStepCap 只允许 app.js 的 legacy fallback', () => {
  const outside = run([file('scripts/probe.mjs', 'const step = peripheralStepCap(snapshot, dt);\n')]);
  assert.equal(outside.problems.length, 1);
  assert.match(outside.problems[0], /\[ARCH-STEP-01\]/);

  const formal = run([file('web/app.js', 'if (spaceMove) step = Math.min(step, peripheralStepCap(snapshot, dt));\n')]);
  assert.equal(formal.problems.length, 1, '同一行含 spaceMove 必须红');

  const formal2 = run([file('web/app.js', 'step = playerGameStep(snapshot, dt) || peripheralStepCap(snapshot, dt);\n')]);
  assert.equal(formal2.problems.length, 1, '同一行含 playerGameStep 必须红');

  const legacy = [
    '    if (spaceMove) step=Math.min(step, playerStepCap(snapshot,dt));',
    '    else if (!inCamp(walker.x+.5,walker.y+.5)) step=Math.min(step, peripheralStepCap(snapshot,dt));',
    '',
  ].join('\n');
  assert.deepEqual(run([file('web/app.js', legacy)]).problems, []);

  const noGuard = [
    '    if (!inCamp(walker.x+.5,walker.y+.5)) step=Math.min(step, peripheralStepCap(snapshot,dt));',
    '',
  ].join('\n');
  assert.equal(run([file('web/app.js', noGuard)]).problems.length, 1, '缺 if (spaceMove) 前置守卫必须红');

  assert.deepEqual(run([file('web/app.js', 'function peripheralStepCap(snapshot, dt) {\n')]).problems, []);
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
  // 白名单文件整字段写入放行；测试文件不参与。
  assert.deepEqual(run([file('life/actor-pos.mjs', '  w.occupancy = next;\n')]).problems, []);
  assert.deepEqual(run([file('life/camp-instances.mjs', '  fresh.loc = { ...x };\n')]).problems, []);
  assert.deepEqual(run([file('life/rogue.test.mjs', '  w.playerPos = {};\n')]).problems, []);
  // 施工任务的 t.loc、以及派生索引的局部字段，不是“整字段写位置”，不得误报。
  assert.deepEqual(run([file('life/rogue.mjs', "  if (t.loc === 'yard') return;\n")]).problems, []);
  assert.deepEqual(run([file('life/rogue.mjs', '  w.loc.p1 = "hall";\n')]).problems, []);
  // m3-planner 的 s 是 ActionState，只放行 s.loc；同文件的 w 位置写入仍红。
  assert.deepEqual(run([file('life/m3-planner.mjs', "  else s.loc='watch';\n")]).problems, []);
  const plannerRogue = run([file('life/m3-planner.mjs', '  w.playerPos = pos;\n')]);
  assert.equal(plannerRogue.problems.length, 1);
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

// Phase D 闸门：生存单世界接 host/前端/持久化，且 town A/B 基线不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurvPlay, tickSurvPlay, survAct, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { host } from './host.mjs';
import { doExchange } from './production.mjs';

test('D1 生存单世界创建：preset=survival、coop 开、居民+玩家齐', () => {
  const sp = createSurvPlay(7);
  assert.equal(sp.world.preset, 'survival');
  assert.equal(sp.world.survival.coop.enabled, true);
  for (const id of ['a1', 'a2', 'a3', 'p1']) assert.ok(sp.world.agents[id]);
});

test('D2 随拍推进：t 递增、日界消耗、合作自动完工', () => {
  const sp = createSurvPlay(7);
  sp.world.survival.store = 0; // 触发公共需求 → 合作
  let completed = null;
  for (let i = 0; i < 200 && !completed; i++) { tickSurvPlay(sp); completed = sp.world.survival.coop.completions[0] ?? null; }
  assert.ok(sp.world.t > 0);
  assert.ok(completed, '合作应随 tick 自动完工');
});

test('D3 玩家生存动作：move/gather/plan/build 生效；未知 kind 拒绝', () => {
  const sp = createSurvPlay(7);
  assert.equal(survAct(sp, { kind: 'move', room: 'yard' }).ok, true);
  assert.equal(sp.world.loc.p1, 'yard');
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  assert.equal(survAct(sp, { kind: 'nope' }).ok, false);
  sp.world.survival.inv.wood = 5; sp.world.survival.inv.stone = 3;
  assert.equal(survAct(sp, { kind: 'plan', type: 'granary' }).ok, true);
  for (let i = 0; i < 3; i++) survAct(sp, { kind: 'build' });
  assert.equal(sp.world.survival.buildings.length, 1);
});

test('D4 survView 载荷齐全（前端只读这份）', () => {
  const v = survView(createSurvPlay(7));
  for (const k of ['t', 'phase', 'store', 'storeCap', 'plots', 'inv', 'buildings', 'coop', 'loc', 'agents', 'buildingsDef', 'rooms', 'outdoor', 'day', 'targetDays']) assert.ok(k in v, `缺 ${k}`);
});

test('D5 持久化 round-trip：t/粮仓/建筑/合作状态读回一致', () => {
  const sp = createSurvPlay(7);
  sp.world.survival.coop.enabled = false; // 隔离自动建设，单测持久化
  for (let i = 0; i < 30; i++) tickSurvPlay(sp);
  sp.world.survival.buildings.push({ type: 'granary', loc: 'yard', integrity: 1 });
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  const back = loadSurv(raw, 7);
  assert.equal(back.world.t, sp.world.t);
  assert.equal(back.world.survival.store, sp.world.survival.store);
  assert.equal(back.world.survival.buildings.length, 1);
  assert.equal(back.world.survival.coop.enabled, sp.world.survival.coop.enabled);
  // 缺省 tolerant：无 survival 键不炸
  assert.ok(loadSurv(undefined, 7).world.survival);
});

test('D7 重置世界同时重置生存单世界（回零刻、清失败态）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-survreset-'));
  process.env.DATA_DIR = dir; process.env.SEED_FILE = join(dir, 'none.json');
  process.env.BRAIN = 'local'; process.env.MODEL_PROVIDERS = ''; process.env.MODEL_KEYS = '';
  try {
    await host.start();
    for (let i = 0; i < 5; i++) await host.ctl({ action: 'step' });
    assert.ok(host.snapshot().survival.t > 0);
    await host.ctl({ action: 'reset' });
    const snap = host.snapshot();
    assert.ok(snap.survival.t <= 1, '重置后生存世界应回零刻');
    assert.equal(snap.survival.failed, false);
    assert.equal(snap.survival.store, 6, '重置后粮仓回初始值');
  } finally {
    host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D8 occupancy 不变量：合作改位置也必须同步占位，否则 move() 崩→agentError 冻结 AI', async () => {
  const sp = createSurvPlay(7);
  sp.world.survival.store = 0; // 触发合作采集/奠基/施工
  for (let i = 0; i < 120; i++) await tickSurvPlay(sp);
  assert.deepEqual(sp.log.filter((x) => x.kind === 'agentError'), [], '不得有 agentError');
  for (const id of Object.keys(sp.world.agents)) {
    const loc = sp.world.loc[id];
    const at = sp.world.occupancy[loc] ?? [];
    assert.ok(at.includes(id), `${id} 在 ${loc} 但占位里没有它`);
    for (const [l, ids] of Object.entries(sp.world.occupancy)) {
      const n = ids.filter((x) => x === id).length;
      assert.equal(n, l === loc ? 1 : 0, `${id} 占位重复/错位：${l}×${n}`);
    }
  }
});

test('D9 读档重建 occupancy：存档位置与占位必须一致（否则重启后第一次 move 崩）', async () => {
  const sp = createSurvPlay(7);
  for (let i = 0; i < 30; i++) await tickSurvPlay(sp);
  sp.world.loc.a1 = 'garden'; // 模拟旧档：位置偏离创建期 spawn
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7);
  for (const id of Object.keys(back.world.agents)) {
    const loc = back.world.loc[id];
    assert.ok((back.world.occupancy[loc] ?? []).includes(id), `读档后 ${id} 在 ${loc} 但占位缺失`);
  }
  assert.ok(!(back.world.occupancy.home ?? []).includes('a1'), '旧 spawn 占位不得残留');
  sp.log.push({ t: sp.world.t, kind: 'agentError', ok: false, code: 'old-engine' });
  const back2 = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7);
  assert.deepEqual(back2.log.filter((x) => x.kind === 'agentError'), [], '旧引擎的 agentError 不应随档回来');
});

test('D6 host 集成：/world 带 survival、A/B 仍 town；mode=survival 动作不污染 A/B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-surv-'));
  process.env.DATA_DIR = dir; process.env.SEED_FILE = join(dir, 'none.json');
  process.env.BRAIN = 'local'; process.env.MODEL_PROVIDERS = ''; process.env.MODEL_KEYS = '';
  try {
    await host.start();
    const snap = host.snapshot();
    assert.ok(snap.survival, '/world 应带 survival');
    assert.equal(Object.keys(snap.A.rooms).length, 8, 'A 侧仍 town（8 房间）');
    assert.ok(snap.A.rooms && snap.B.rooms, 'A/B 对照仍在');
    const locBefore = JSON.stringify(snap.A.loc);
    await host.act({ mode: 'survival', kind: 'move', room: 'yard' }); // P0-3：采集须在资源地点（开局 hall 不可采）
    const r = await host.act({ mode: 'survival', kind: 'gather' });
    assert.equal(r.ok, true);
    const after = host.snapshot();
    assert.equal(JSON.stringify(after.A.loc), locBefore, '生存动作不应改 A/B');
    assert.ok((after.survival.pinv?.p1?.wood ?? 0) >= 2 || (after.survival.pinv?.p1?.stone ?? 0) >= 2, '生存采集应入个人背包（§15 P2-C）');
  } finally {
    host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D10 玩家动作过规则层：位置不对先被裁决拒绝，地点对才允许', async () => {
  const sp = createSurvPlay(7);
  const w = sp.world;
  w.survival.plots[0].growth = 1;
  const bad = survAct(sp, { kind: 'harvest' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'NOT_GARDEN', '走廊收菜必须被规则层拒绝');
  const dep = survAct(sp, { kind: 'deposit', type: 'wood' });
  assert.equal(dep.ok, false);
  assert.equal(dep.code, 'NOT_STORE', '非公仓存取必须被拒绝');
  assert.ok(survAct(sp, { kind: 'move', room: 'garden' }).ok);
  const good = survAct(sp, { kind: 'harvest' });
  assert.equal(good.ok, true, '菜园收菜应通过规则层');
});

test('D11 兑换用 effectiveMods 仓容：谷仓后 20 粮仍可兑，无谷仓则封顶', () => {
  const mk = (granary) => {
    const sp = createSurvPlay(7);
    const s = sp.world.survival;
    s.store = 20; s.produce.berry = 1;
    if (granary) s.buildings.push({ type: 'granary', loc: 'yard', integrity: 1 });
    return doExchange(sp.world, 'p1', 'berry');
  };
  assert.equal(mk(false).code, 'STORE_FULL', '无谷仓：24×0.7=16.8，20 份应拒兑');
  assert.equal(mk(true).ok, true, '有谷仓：36×0.7=25.2，20 份应允许');
});

test('D12 住户模式：已婚同住有床即可繁衍，不再要求抽象 shelter', async () => {
  const sp = createSurvPlay(7, { residentialDecisions: true });
  const w = sp.world, s = w.survival;
  w.sex.a1 = 'M'; w.sex.a2 = 'F';
  s.households.spouses.a1 = 'a2'; s.households.spouses.a2 = 'a1';
  w.housing.a1 = w.housing.a2;
  s.store = 30;
  assert.ok(!s.buildings.some((b) => b.type === 'shelter'), '本测试不建 shelter');
  w.t = 23;
  await tickSurvPlay(sp);
  assert.ok((s.births ?? 0) >= 1, '已婚同住有床应繁衍');
});

test('D13 玩家同等生存：有存续、会因归零死亡，尸检后动作被锁', async () => {
  const sp = createSurvPlay(7);
  const w = sp.world;
  const v0 = w.agents.p1.viab.v;
  for (let i = 0; i < 5; i++) await tickSurvPlay(sp);
  assert.ok(w.agents.p1.viab.v < v0, '基础代谢必须真的扣玩家存续');
  w.agents.p1.viab.v = 0.0005;
  await tickSurvPlay(sp);
  assert.equal(w.survival.playerDead, true);
  assert.equal(w.survival.failed, true);
  assert.equal(survView(sp).player.dead, true);
  assert.equal(survAct(sp, { kind: 'move', room: 'garden' }).ok, false);
});

test('D14 家里容器是日耗缓冲：公仓空时先吃它，不立刻记饥荒', async () => {
  const sp = createSurvPlay(7);
  const w = sp.world, s = w.survival;
  s.store = 0;
  s.campContainers = { 'home:meal': { berry: 4 } };
  for (const a of Object.values(w.agents)) a.viab.v = 1;
  w.t = 23;
  await tickSurvPlay(sp);
  assert.equal(s.starveDays, 0, '容器食物应先抵缺口');
  assert.equal(s.campContainers['home:meal'].berry, 0, '缓冲应被吃掉');
});

// Phase D 闸门：生存单世界接 host/前端/持久化，且 town A/B 基线不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurvPlay, tickSurvPlay, survAct, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { host } from './host.mjs';

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
    const r = await host.act({ mode: 'survival', kind: 'gather' });
    assert.equal(r.ok, true);
    const after = host.snapshot();
    assert.equal(JSON.stringify(after.A.loc), locBefore, '生存动作不应改 A/B');
    assert.ok(after.survival.inv.wood >= 2 || after.survival.inv.stone >= 2, '生存采集应入生存库存');
  } finally {
    host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

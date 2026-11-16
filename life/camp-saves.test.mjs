// C1 闸门：实例隔离 / 往返不动点与对账 / 名字安全 / TTL 不删活跃 / 列表投影。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CampInstances, normalizeName, listSaves, savesDir, sweepSaves, touchSave } from './camp-instances.mjs';
import { dumpSurv, loadSurv } from './survplay.mjs';

const SEED = JSON.parse(readFileSync(new URL('../seed/world.json', import.meta.url), 'utf8')).survival;
const OPTIONS = { independentWorld: true, gameRules: true };
const dir = () => mkdtempSync(join(tmpdir(), 'camps-'));

test('SA1 隔离：两个名字是两个世界，改 A 不动 B', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 4 });
  const a = mgr.open('阿禾');
  const b = mgr.open('阿石');
  assert.ok(a.ok && b.ok, a.code + '/' + b.code);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.sp, b.sp, '不能共享同一个 sp');
  const beforeB = dumpSurv(b.sp);
  a.sp.world.survival.store = 3;
  a.sp.world.t += 5;
  assert.equal(b.sp.world.survival.store, JSON.parse(JSON.stringify(beforeB)).survival.store, 'B 的公仓不该被 A 改动');
  assert.equal(b.sp.world.t, beforeB.t, 'B 的刻数不该被 A 改动');
});

test('SA2 往返：dump→load 后进入不动点，且继承 Σfood===store 对账', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 2 });
  const a = mgr.open('阿禾');
  assert.ok(a.ok);
  a.sp.world.survival.store = 12;
  mgr.persist();
  const reload = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 2 });
  const b = reload.open('阿禾');
  assert.ok(b.ok, b.code);
  const s = b.sp.world.survival;
  const sum = Object.values(s.food ?? {}).reduce((x, y) => x + y, 0);
  assert.equal(sum, s.store, '往返后 Σfood 必须等于 store');
  const d1 = dumpSurv(b.sp);
  const d2 = dumpSurv(loadSurv(d1, OPTIONS.seed ?? 7, OPTIONS));
  const d3 = dumpSurv(loadSurv(d2, OPTIONS.seed ?? 7, OPTIONS));
  assert.deepEqual(d2, d3, '第二、三次 dump 必须逐位相同（进入不动点）');
});

test('SA5 名字安全：分隔符/.. /超长/控制符/零宽一律拒绝，且不产生文件', () => {
  const dataDir = dir();
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '...', 'x'.repeat(40), 'a\u0000b', 'a\u200bb']) {
    const r = normalizeName(bad);
    assert.equal(r.ok, false, '应拒绝: ' + JSON.stringify(bad));
    assert.ok(r.code, '拒绝必须给 code');
  }
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 2 });
  assert.equal(mgr.open('../x').ok, false);
  const dirPath = savesDir(dataDir);
  const files = existsSync(dirPath) ? readdirSync(dirPath) : [];
  assert.equal(files.length, 0, '拒绝时不得产生任何文件，实测 ' + files.join(','));
  // 合法名字里带空格与中文：接受，key 由归一化名字派生
  const ok = normalizeName('  阿禾 ');
  assert.equal(ok.ok, true);
  assert.equal(ok.display, '阿禾');
  assert.equal(ok.key.length, 32);
  assert.equal(normalizeName('阿禾').key, ok.key, '大小写/空白归一化后同 key');
});

test('SA4 TTL：删 3 天无活跃的，正在被观看的绝不删', () => {
  const dataDir = dir();
  const now = Date.now();
  touchSave(dataDir, { key: 'k-old', name: '旧', day: 3, population: 2, status: 'active', lastSeenAt: now - 4 * 86400000 });
  touchSave(dataDir, { key: 'k-watched', name: '看', day: 3, population: 2, status: 'active', lastSeenAt: now - 4 * 86400000 });
  touchSave(dataDir, { key: 'k-live', name: '新', day: 3, population: 2, status: 'active', lastSeenAt: now });
  const r = sweepSaves(dataDir, { now, isWatched: (key) => key === 'k-watched' });
  assert.deepEqual(r.removed, ['k-old']);
  const left = listSaves(dataDir, now).map((e) => e.name).sort();
  assert.deepEqual(left, ['新', '看'].sort());
});

test('SA6 列表投影：只给五项，不含背包/关系/对话', () => {
  const dataDir = dir();
  touchSave(dataDir, { key: 'k1', name: '<img onerror=alert(1)>', day: 9, population: 4, status: 'active', lastSeenAt: Date.now(), pinv: { crop: 9 }, relations: { a: 1 }, converseLog: [1] });
  const row = listSaves(dataDir)[0];
  assert.deepEqual(Object.keys(row).sort(), ['day', 'daysLeft', 'lastSeenAt', 'name', 'population', 'status'].sort());
  assert.equal(row.name, '<img onerror=alert(1)>', '名字按原样返回，转义由渲染层负责');
});

test('SA3 fork 起点：从 40 天种子开新营地，阈值照 seed-archive 口径（不得放宽）', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 3 });
  const r = mgr.open('新来的');
  assert.ok(r.ok, r.code);
  const dump = dumpSurv(r.sp);
  const s = dump.survival;
  assert.ok(Number.isSafeInteger(dump.t) && dump.t > 0, '刻数必须 > 0');
  assert.notEqual(s.ended, true, '不得是终局');
  assert.ok(Object.values(dump.minds).filter((m) => m && !m.dead).length >= 4, '在世居民至少 3 + 玩家');
  assert.ok(Number(s.store) > 0, '公仓必须 > 0');
  assert.ok(Object.keys(s.buildings ?? {}).length >= 3, '建筑至少 3 座');
  assert.equal(s.playerDead, false);
  const p1 = dump.minds.p1;
  assert.ok(p1 && !p1.dead && Number(p1.viab?.v) >= 0.9, '玩家必须是活着的新到者');
  assert.ok(dump.loc?.p1 && (dump.occupancy?.[dump.loc.p1] ?? []).includes('p1'), '玩家必须在占用表里');
  // 起点来自种子（第 40 天），不是第 1 天
  assert.equal(dump.t, SEED.t, '新营地必须从种子刻数起步');
});

test('SA7 三态：表格逐格（有观众→watched；无人主营地→node；无人分名字→idle；无人未开启→off）', async () => {
  const { modelLaneFor } = await import('./camp-lane.mjs');
  assert.equal(modelLaneFor({ campKey: 'MAIN', watched: true, unattendedOn: true }), 'watched');
  assert.equal(modelLaneFor({ campKey: 'abc', watched: true, unattendedOn: false }), 'watched');
  assert.equal(modelLaneFor({ campKey: 'MAIN', watched: false, unattendedOn: true }), 'node');
  assert.equal(modelLaneFor({ campKey: 'abc', watched: false, unattendedOn: true }), 'idle');
  assert.equal(modelLaneFor({ campKey: 'MAIN', watched: false, unattendedOn: false }), 'off');
  // SA8：同一判定对两份不同营地互不影响（纯函数，无共享计数）
  const a = modelLaneFor({ campKey: 'a', watched: false, unattendedOn: true });
  const b = modelLaneFor({ campKey: 'b', watched: false, unattendedOn: true });
  assert.deepEqual([a, b], ['idle', 'idle']);
});

test('SA9 按营地 tick：一份管理器里的每个常驻营地都各走一刻，互不代跑', async () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 4 });
  const a = mgr.open('甲');
  const b = mgr.open('乙');
  assert.ok(a.ok && b.ok);
  const t0a = a.sp.world.t, t0b = b.sp.world.t;
  await mgr.tickAll({ budgetMs: 20000 });
  assert.equal(a.sp.world.t, t0a + 1, '甲应当前进一刻');
  assert.equal(b.sp.world.t, t0b + 1, '乙也应当前进一刻（只 tick 第一份就会红）');
});

test('SA5b camp key：32 位十六进制 ∧ 必须是索引成员；穿越串零写入', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 2 });
  // 在 saves/ 之外放一个"受害者"，再用穿越串去开它
  mkdirSync(join(dataDir, 'archive-2026'), { recursive: true });
  writeFileSync(join(dataDir, 'archive-2026', 'victim.json.gz'), 'victim');
  const victimBefore = statSync(join(dataDir, 'archive-2026', 'victim.json.gz')).mtimeMs;
  assert.equal(mgr.openKey('../archive-2026/victim'), null, '穿越串必须被拒');
  assert.equal(mgr.live.size, 0, '穿越串不得进入常驻');
  assert.equal(statSync(join(dataDir, 'archive-2026', 'victim.json.gz')).mtimeMs, victimBefore, '不得改写 saves 之外的文件');
  // 格式合法但不在索引里：同样不能开（防"复活孤儿文件"）
  const fake = 'a'.repeat(32);
  mkdirSync(join(dataDir, 'saves'), { recursive: true });
  writeFileSync(join(dataDir, 'saves', fake + '.json.gz'), 'orphan');
  assert.equal(mgr.openKey(fake), null, '不在索引里的 key 不得打开');
  // 合法且已登记：可以开
  const opened = mgr.open('正常');
  assert.ok(opened.ok);
  assert.ok(mgr.openKey(opened.key));
});

test('SA4b 常驻但 3 天无人：必须被扫掉（落盘不得刷新活跃时间）', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 3 });
  const camp = mgr.open('老营地');
  assert.ok(camp.ok);
  const key = camp.key;
  // 模拟"一直常驻、但三天没人来"
  mgr.live.get(key).lastSeenAt = Date.now() - 4 * 86400000;
  mgr.persist(); // 旧实现会在这里把 lastSeenAt 刷成 now ⇒ 永远删不掉
  const r = sweepSaves(dataDir, { now: Date.now() });
  assert.ok(r.removed.includes(key), '常驻不等于活跃：三天无人必须删，实测 removed=' + JSON.stringify(r.removed));
});

test('SAV-01 坏档拒绝载入：不得当成第 0 刻新营地，更不得覆盖唯一副本', () => {
  const dataDir = dir();
  const mgr = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 3 });
  const a = mgr.open('阿禾');
  assert.ok(a.ok);
  const f = join(savesDir(dataDir), a.key + '.json.gz');
  // 语义坏档：gzip 能解、JSON 能解析，但形状不完整（loadSurv 会当成新世界）
  writeFileSync(f, gzipSync(Buffer.from('{}')));
  const size = statSync(f).size, mtime = statSync(f).mtimeMs;
  mgr.close();
  const again = new CampInstances({ dataDir, options: OPTIONS, seedSurvival: SEED, limit: 3 });
  const b = again.open('阿禾');
  assert.equal(b.ok, false, '坏档必须拒绝载入');
  assert.equal(b.code, 'CAMP_CORRUPT');
  assert.equal(again.live.size, 0, '坏档不得进入常驻（避免被 save 写回）');
  assert.equal(statSync(f).size, size, '唯一副本不得被改写');
  assert.equal(statSync(f).mtimeMs, mtime, '唯一副本 mtime 不得变');
});

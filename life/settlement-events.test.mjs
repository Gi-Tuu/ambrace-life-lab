import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { stepCooperation } from './cooperation.mjs';
import { doRepair } from './production.mjs';
import { recordSettlementEvent, SETTLEMENT_EVENT_LIMIT } from './settlement-events.mjs';

const seedFile = new URL('../seed/world.json', import.meta.url);
const archive = JSON.parse(await readFile(seedFile, 'utf8'));
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'ambrace-settlement-events-'));
// The host fixture gives the player the material needed for one paired repair.
process.env.SEED_FILE = join(process.env.DATA_DIR, 'seed.json');
const hostSeed = structuredClone(archive);
hostSeed.survival.pinv.p1 = { wood: 1, stone: 1 };
await writeFile(process.env.SEED_FILE, JSON.stringify(hostSeed));
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.V72_TIME = '1';
process.env.SETTLEMENT_DISCUSSIONS = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '1000000'; // 旧“每刻结算”时序闸门：冻住连续钟，世界只随显式 step 走
const { host, survivalOptions } = await import('./host.mjs');
// P1：这条闸门钉的是旧"每刻结算"的风暴/账本时序；连续时钟的行为由 p1-continuous-clock.test.mjs 覆盖。
const options = { ...survivalOptions(), simTime: false, adoptArchivedRules: true, upgradeLegacyEventRules: true };

test('same-seed storm records the forecast, verified damage and every actual repair', async () => {
  const natural = loadSurv(structuredClone(archive.survival), archive.seed, options);
  const control = loadSurv(structuredClone(archive.survival), archive.seed, options);
  control.world.ecologyExperiment = { noStorm: true };
  assert.deepEqual(survView(natural).settlementEvents, [], 'old save has no fabricated history');
  for (const sp of [natural, control]) {
    while (sp.world.t < 1656) await tickSurvPlay(sp, { now: (sp.world.t + 1) * 1000 });
  }
  const events = survView(natural).settlementEvents;
  const storm = events.filter(row => row.stormDay === 67);
  const impact = storm.find(row => row.kind === 'storm_impact');
  // V7.3.1：取消每刻动作资格上限后，风暴窗口内的行动时序发生变化（修复提前、部分社交事件不再触发）；
  // 这里只锁定世界事实：预警 1584、损伤 1608、修复全部发生在损伤之后且逐项对得上。
  assert.equal(storm.find((row) => row.kind === 'storm_warning')?.t, 1584);
  assert.equal(impact?.t, 1608);
  assert.ok(!storm.some((row) => row.kind === 'repair' && row.t < impact.t), '损伤前不得有修复');
  // P2b：居民旅行接入 space.speedBudget（22.5/刻，旧 12/刻）后，到 67 日风暴时已建成/占位的
  // 建筑组合改变 ⇒ 受损建筑从 5 降到 4。世界事实（预警/损伤/修复顺序、逐项耗材）不变；
  // 下界随轨迹调整，证据见 evidence/redo-p2b/。
  assert.ok(impact.buildings.length >= 4, `至少 4 处建筑受损，实测 ${impact.buildings.length}`);
  // P2c：居民改为沿 space 路径连续移动后，风暴当日地块水分轨迹再变（P2b 0.30 → 0.42，到点 +1 缓冲后 0.42）；
  // 这里钉的是"风暴后地块被损坏"这一世界事实，具体数值随轨迹更新（见 P2c 回报 §长程变化）。
  if (impact.plot) assert.equal(impact.plot.after, .42);
  const repairs = storm.filter(row => row.kind === 'repair');
  assert.ok(repairs.length >= 3, '损伤后应有修复');
  for (const repair of repairs) {
    assert.equal(repair.damageId, impact.id);
    assert.equal(repair.after, 1);
    const spent = { wood: (repair.spent?.bag?.wood ?? 0) + (repair.spent?.store?.wood ?? 0),
      stone: (repair.spent?.bag?.stone ?? 0) + (repair.spent?.store?.stone ?? 0) };
    assert.deepEqual(spent, { wood: 1, stone: 1 }, '每次修复总耗 1 木 1 石（来源可不同）');
  }

  // V7.3.1/P2b：借料请求是否发生、以及"第 N 条是 delivered 还是 expired"随行动轨迹变化；
  // 但同一 requestId 的记录必须一致：先 opened，后续 deliver/expire/decline；不得带 stormDay。
  const borrowing = events.filter(row => row.kind === 'resource_request');
  const byRequest = new Map();
  for (const row of borrowing) {
    const list = byRequest.get(row.requestId) ?? [];
    list.push(row);
    byRequest.set(row.requestId, list);
  }
  for (const rows of byRequest.values()) {
    // 旧档/日志尾部可能只保住终态（opened 早于保留窗口），所以只要求：至少一条、至多一个终态。
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(row => ['opened', 'delivered', 'expired', 'declined'].includes(row.result)));
    assert.ok(rows.filter(row => row.result !== 'opened').length <= 1, '同一请求不得出现多个终态');
    assert.equal(new Set(rows.map(row => row.target)).size, 1, '同一请求的目标不得变化');
    const delivered = rows.find(row => row.result === 'delivered');
    if (delivered) assert.deepEqual(delivered.delivered, { item: 'wood', amount: 1 });
  }
  assert.ok(borrowing.every(row => row.stormDay === undefined));
  const noStorm = survView(control).settlementEvents;
  assert.ok(!noStorm.some(row => row.stormDay !== undefined));
  assert.ok(noStorm.some(row => row.kind === 'repair' && row.ok), 'ordinary weather can still trigger repairs');
});

test('failed repair spends nothing and an actual withdrawal records its reason', () => {
  const sp = createSurvPlay(7, { ...options });
  const w = sp.world;
  w.survival.buildings.push({ loc: w.loc.p1, type: 'shelter', integrity: .6 });
  w.survival.inv = { wood: 0, stone: 0 };
  w.pinv.p1 = { wood: 0, stone: 0 };
  assert.equal(survAct(sp, { kind: 'repair' }).code, 'NO_MATERIAL');
  const getEvents = () => survView(sp).settlementEvents;
  assert.deepEqual(getEvents().map(row => [row.kind, row.ok, row.code]), [['repair', false, 'NO_MATERIAL']]);
  assert.equal(w.survival.buildings[0].integrity, .6);
  w.pinv.p1.wood = 1;
  w.survival.inv.stone = 1;
  assert.equal(doRepair(w, 'p1').ok, true);
  assert.deepEqual(getEvents().at(-1).spent, { bag: { wood: 1, stone: 0 }, store: { wood: 0, stone: 1 } });
  assert.equal(getEvents().at(-1).stormDay, undefined);

  w.agents.a1.drives.v.energy = 0.1;
  w.survival.coop.task = { type: 'shelter', repair: true, loc: w.loc.p1, phase: 'repair', workers: ['a1'], startedAt: 0 };
  stepCooperation(w);
  const exit = getEvents().find(row => row.kind === 'cooperation_exit');
  assert.equal(exit.actor, 'a1');
  assert.equal(exit.reason, 'STAMINA');
});

test('journal retains a bounded tail and continues sequence after old and new saves', () => {
  const sp = createSurvPlay(7, { ...options });
  for (let i = 0; i < SETTLEMENT_EVENT_LIMIT + 3; i++) {
    recordSettlementEvent(sp.world, 'work_interrupted', { actor: 'a1' });
  }
  const snapshot = survView(sp).settlementEvents;
  assert.equal(snapshot.length, SETTLEMENT_EVENT_LIMIT);
  assert.equal(snapshot[0].id, 4);
  const copy = loadSurv(structuredClone(dumpSurv(sp)), 7, options);
  assert.deepEqual(survView(copy).settlementEvents, snapshot);
  recordSettlementEvent(copy.world, 'work_interrupted', { actor: 'a2' });
  assert.equal(survView(copy).settlementEvents.at(-1).id, SETTLEMENT_EVENT_LIMIT + 4);
  assert.equal(survView(sp).settlementEvents.at(-1).id, SETTLEMENT_EVENT_LIMIT + 3);
});

test('host exposes independent journal records in survival, A and B', async () => {
  await host.start();
  try {
    assert.equal(host.snapshot().survival.t, 960);
    const status = await host.ctl({ mode: 'compare', action: 'compare_reset', confirm: true, fromSurvival: true });
    assert.equal(status.ok, true);
    const official = structuredClone(host.snapshot().survival.settlementEvents);
    const pair = host.snapshot('compare').comparison;
    assert.deepEqual(pair.A.settlementEvents, official);
    assert.deepEqual(pair.B.settlementEvents, official);

    const [target] = pair.A.buildings;
    const point = [target.lot.x + target.lot.w / 2, target.lot.z + target.lot.d / 2];
    const far = point.map(value => value + 10);
    const r = await host.act({
      mode: 'compare', revision: pair.revision, kind: 'repair', target: `work:${target.loc}:${target.type}`,
      from: point, otherContact: { from: far, target: `work:${target.loc}:${target.type}` },
    });
    assert.equal(r.sides.A.ok, true, JSON.stringify(r));
    // 1.1：正式态 compare 也走连续钟，长动作（repair=30 分）先 BUSY_START，到点才按同一
    // 连续性规则结算；旧“每刻结算”下则当场拒绝。两种都属于同一分钟/刻断言，独立性不放宽：
    // B 的 far 上报最终必须被 OUT_OF_REACH 拒绝，A 必须成功。
    assert.ok(r.sides.B.ok === false || r.sides.B.code === 'BUSY_START', JSON.stringify(r.sides.B));
    if (r.sides.A.code === 'BUSY_START' || r.sides.B.code === 'BUSY_START') {
      assert.equal((await host.ctl({mode:'compare', action:'step'})).ok, true);
    }
    const after = host.snapshot('compare').comparison;
    const lastRepair = (side) => side.settlementEvents.findLast((e) => e.kind === 'repair' && e.actor === 'p1');
    assert.equal(lastRepair(after.A)?.ok, true);
    assert.equal(lastRepair(after.A)?.kind, 'repair');
    // 连续钟的长动作在到点时走 advancePlayerBusy：失败记 player_action(aborted)，不再补一条
    // repair 失败；旧“每刻结算”则在 repair 事件里直接失败。两者都必须带 OUT_OF_REACH。
    const failed = after.B.settlementEvents.findLast((e) =>
      (e.kind === 'repair' || (e.kind === 'player_action' && e.action === 'repair')) && e.actor === 'p1');
    assert.equal(failed?.code, 'OUT_OF_REACH');
    assert.ok(failed?.ok === false || failed?.status === 'aborted');
    assert.deepEqual(host.snapshot().survival.settlementEvents, official);

    await host.stop();
    await host.start();
    const restored = host.snapshot('compare');
    assert.deepEqual(restored.comparison.A.settlementEvents, after.A.settlementEvents);
    assert.deepEqual(restored.comparison.B.settlementEvents, after.B.settlementEvents);
    assert.deepEqual(restored.survival.settlementEvents, official);
  } finally {
    await host.stop();
  }
});






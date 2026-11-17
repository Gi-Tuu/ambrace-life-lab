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
const { host, survivalOptions } = await import('./host.mjs');
const options = { ...survivalOptions(), adoptArchivedRules: true, upgradeLegacyEventRules: true };

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
  assert.deepEqual(storm.map(row => [row.t, row.kind]), [
    [1584, 'storm_warning'], [1595, 'storm_observed'], [1599, 'discussion'], [1608, 'storm_impact'],
    [1618, 'repair'], [1626, 'repair'], [1630, 'repair'], [1633, 'repair'], [1640, 'repair'],
  ]);
  assert.equal(storm[1].actor, 'c4');
  assert.deepEqual(storm[2].advice, { a1: '先避险', c4: '先避险' });
  assert.equal(impact.buildings.length, 6);
  assert.deepEqual(impact.buildings[0], { loc: 'watch', type: 'shelter', before: .89, after: .74 });
  assert.equal(impact.plot.id, 3);
  assert.equal(impact.plot.after, .29);
  const repairs = storm.filter(row => row.kind === 'repair');
  assert.deepEqual(repairs.map(row => row.loc), ['district-northwest', 'well', 'yard', 'watch', 'garden']);
  for (const repair of repairs) {
    assert.equal(repair.damageId, impact.id);
    assert.equal(repair.after, 1);
    assert.deepEqual(repair.spent, { bag: { wood: 1, stone: 1 }, store: { wood: 0, stone: 0 } });
  }
  assert.equal(repairs.filter(row => row.taskStartedAt !== undefined).length, 3);
  assert.equal(events.find(row => row.kind === 'discussion' && row.t === 1626).result, 'no_quorum');

  const borrowing = events.filter(row => row.kind === 'resource_request' && row.t === 1604);
  assert.deepEqual(borrowing.map(row => row.result), ['opened', 'delivered']);
  assert.equal(borrowing[0].requestId, borrowing[1].requestId);
  assert.equal(borrowing[0].target, borrowing[1].target);
  assert.deepEqual(borrowing[1].delivered, { item: 'wood', amount: 1 });
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
    assert.equal(r.sides.B.ok, false);
    const after = host.snapshot('compare').comparison;
    assert.equal(after.A.settlementEvents.at(-1).kind, 'repair');
    assert.equal(after.A.settlementEvents.at(-1).actor, 'p1');
    assert.equal(after.B.settlementEvents.at(-1).code, 'OUT_OF_REACH');
    assert.equal(after.B.settlementEvents.at(-1).ok, false);
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

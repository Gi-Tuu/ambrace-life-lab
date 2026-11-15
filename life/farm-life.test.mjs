import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { DAY_TICKS, SEASON_DAYS } from './clock.mjs';
import { move } from './body.mjs';
import { goalCandidates } from './goals.mjs';
import { doExchange, doExpand, regrowWildBerries } from './production.mjs';
import { tillRule } from './farmland.mjs';
import { campPen, campPlants, campSite } from '../web/camp-interaction.mjs';
import { outdoorLife } from '../web/camp-3d-scene.mjs';

const options = { farmLife: true, ecosystem: true, wildFood: true, autonomousGoals: true, independentWorld: true };
const make = () => createSurvPlay(7, options);
const tick = async (sp, count) => {
  for (let i = 0; i < count; i += 1) await tickSurvPlay(sp);
};
const restore = sp => loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, options);

test('田畦迁移保留坐标和 ID，只有真实地块有模型；指定田畦播种、浇水、成熟和收获', async () => {
  const sp = createSurvPlay(7, { ...options, mapSeed: 72, layoutVersion: 1 });
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  for (const p of raw.survival.plots) delete p.bed;
  raw.survival.plots.reverse();
  const migrated = loadSurv(raw, 7, options), w = migrated.world, s = w.survival;
  assert.deepEqual(s.plots.map(p => p.id), [3, 2, 1, 0]);
  const view = survView(migrated);
  const stage = outdoorLife({ ...view, sites: view.layout.sites, tw: 120, th: 80,
    beds: view.plots.map(p => ({ ...p, x: p.bed.x*16, y: p.bed.z*16, w: p.bed.w*16, h: p.bed.d*16 })) });
  const soil = stage.boxes.filter(b => b.occluder?.startsWith('plot:') && b.h === .04);
  assert.deepEqual(soil.map(b => [b.occluder, b.x, b.z]), view.plots.map(p => ['plot:'+p.id, p.bed.x, p.bed.z]));

  const plot = s.plots.find(p => p.id === 3), from = plot.at;
  plot.growth = 0;
  assert.equal(survAct(migrated, { kind:'camp_plant', tool:'hoe', plot: 6, from }).code, 'BAD_PLOT');
  assert.equal(survAct(migrated, { kind:'camp_plant', tool:'hoe', plot: 3, from: [0, 0] }).code, 'OUT_OF_REACH');
  assert.ok(survAct(migrated, { kind:'camp_plant', tool:'hoe', plot: 3, from }).ok);
  assert.equal(plot.growth, .1);
  w.t += 1;
  w.pinv.p1.water = 1;
  const water = s.water;
  assert.ok(survAct(migrated, { kind:'camp_water', tool:'bucket', plot: 3, from }).ok);
  assert.equal(s.water, water);
  assert.equal(plot.moisture, .4);
  assert.equal(s.plots.find(p => p.id === 2).moisture, undefined);
  const loaded = restore(migrated);
  assert.deepEqual(survView(loaded).plots, survView(migrated).plots);
  const crop = { kind:'camp_collect', type:'crop', tool:'basket', plot: 3, from };
  assert.equal(survAct(migrated, crop).code, 'ACTION_BUDGET');
  w.survival.disasters = false;
  // 对照使用同一模拟日界，隔离居民的收种以测量玩家地块。
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.dead = true;
  for (let i = 0; plot.growth < 1 && i < 10; i += 1) {
    w.survival.water = .9;
    await tick(migrated, DAY_TICKS);
  }
  assert.equal(plot.growth, 1);
  assert.ok(survAct(migrated, crop).ok);
  assert.equal(w.pinv.p1.crop, 1);
  await tick(migrated, 1);
  assert.equal(survAct(migrated, crop).code, 'NO_MATURE');
});

test('自然决策开垦并播种，存档恢复；储粮充足、干旱和缺料提供负向对照', async () => {
  const sp = make(), w = sp.world, s = w.survival;
  let tilled;
  w.observeResidentAction = row => {
    if (row.kind === 'till') tilled = row;
  };
  await tick(sp, 6 * DAY_TICKS);
  assert.equal(s.agentErrors ?? 0, 0);
  assert.equal(s.plots.length, 5);
  assert.equal(tilled.goal, 'farmland');
  assert.ok(tilled.paid > 0);
  assert.ok(s.plots.at(-1).growth > 0);
  assert.deepEqual(survView(restore(sp)).plots, survView(sp).plots);

  const control = make(), cw = control.world, cs = cw.survival;
  cs.store = 20;
  assert.ok(!goalCandidates(cw, 'a1').some(a => a.goal === 'farmland'));
  move(cw, 'a1', 'garden');
  cs.drought = true;
  assert.equal(tillRule(cw, 'a1', 4).code, 'POOR_GROUND');
  cs.drought = false;
  cs.inv.wood = 0;
  assert.equal(tillRule(cw, 'a1', 4).code, 'NO_MATERIAL');
  assert.equal(cs.plots.length, 4);
});

test('来源产量与总库存共用一账，幼体、采空和重新生产都可观察', async () => {
  const sp = make(), w = sp.world, s = w.survival;
  s.inv.wood = 20; s.inv.stone = 15;
  assert.ok(doExpand(w, 'a1', 'orchards').ok);
  assert.ok(doExpand(w, 'a1', 'chickens').ok);
  await tick(sp, DAY_TICKS);
  let v = survView(sp);
  for (const item of ['fruit', 'egg']) {
    assert.ok(v.ecoSources[item].some(source => source.mature && source.ready > 0));
    assert.ok(v.ecoSources[item].some(source => !source.mature && source.ready === 0));
  }
  const old = v.ecoSources.fruit.find(p => p.mature && p.ready);
  const plant = campPlants(w.campLayout, undefined, w.mapSeed, w.layoutVersion, v.ecoSources).find(p => p.id === old.id);
  const collect = { kind:'camp_collect', type:'fruit', tool:'basket', target:old.id, from:[plant.x, plant.z] };
  for (let i = 0; i < old.ready; i += 1) {
    w.t += 1;
    assert.ok(survAct(sp, collect).ok);
  }
  w.t += 1;
  assert.equal(survAct(sp, collect).code, 'NO_PRODUCE');
  assert.equal(w.pinv.p1.fruit, old.ready);
  const pen = campPen(campSite('yard')), to = [pen.x+2, pen.z+3];
  for (const [item, tool] of [['egg','basket'],['milk','bucket'],['wool','shears']]) {
    w.t += 1;
    v = survView(sp);
    const source = v.ecoSources[item].find(p => p.ready);
    assert.ok(source);
    const before = s.produce[item];
    assert.ok(survAct(sp, { kind:'camp_collect', type:item, tool, target:source.id, from:to, to }).ok);
    assert.equal(s.produce[item], before-1);
    assert.equal(s.standing[item][source.id], source.ready-1);
  }
  s.store = 0;
  assert.ok(doExchange(w, 'a1', 'fruit').ok);
  assert.equal(Object.values(s.standing.fruit).reduce((a,b)=>a+b,0), s.produce.fruit);
  assert.deepEqual(survView(restore(sp)).ecoSources, survView(sp).ecoSources);

  const berry = campPlants(w.campLayout, undefined, w.mapSeed, w.layoutVersion, v.ecoSources).find(p => p.id === 'berry:yard:0');
  s.berryPatches.yard = [1, 2];
  s.wildBerries.yard = 3;
  w.t += 3;
  const pick = { kind:'camp_collect', type:'berry', tool:'basket', target:berry.id, from:[berry.x,berry.z] };
  assert.ok(survAct(sp, pick).ok);
  w.t += 3;
  assert.equal(survAct(sp, pick).code, 'NO_WILD_FOOD');
  assert.equal(s.berryPatches.yard[1], 2);
  w.weather = 'clear'; s.water = 1; s.drought = false; s.disasterToday = null;
  for (let i = 0; i < 4; i += 1) regrowWildBerries(w, 2);
  assert.ok(survAct(sp, pick).ok);

  const winter = make();
  winter.world.t = 3 * SEASON_DAYS * DAY_TICKS - 1;
  await tick(winter, 1);
  assert.equal(winter.world.survival.produce.fruit, 0);
  assert.equal(winter.world.survival.produce.wool, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { doBuild, doPlan, doRepair, BUILDINGS } from './production.mjs';
import { createSurvPlay, dumpSurv, loadSurv, settleSurvival, survView, tickSurvPlay } from './survplay.mjs';
import { addCampWork, homeAppearance, outdoorHomes, workModelKey } from '../web/camp-3d-scene.mjs';
import { GAME_OPTIONS } from './long-run.mjs';
import { CONSTRUCTION_LOTS, constructionLot, overlapsLot } from '../web/camp-layout.mjs';

test('预留地彼此留有间距，冲突工地拒绝奠基且不扣材料',()=>{
  const lots=Object.values(CONSTRUCTION_LOTS);
  for (const [i,lot] of lots.entries())
    for (const other of lots.slice(i+1)) assert.equal(overlapsLot(lot,other,.35),false);
  const {world}=createSurvPlay();
  const s=world.survival;
  world.loc.p1='yard';
  s.inv={wood:8,stone:8};
  s.sites.push({loc:'garden',lot:constructionLot('yard')});
  assert.equal(doPlan(world,'p1','granary').code,'OCCUPIED');
  assert.deepEqual(s.inv,{wood:8,stone:8});
});

test('真实施工推进地基、框架和完工，碰撞与旧档归位共用地块',()=>{
  const sp=createSurvPlay(), {world}=sp, s=world.survival;
  world.loc.p1='yard';
  s.inv={wood:8,stone:8};
  const draw=()=>{
    const boxes=[], projects=addCampWork(boxes,{...s,buildingsDef:BUILDINGS});
    return {phases:projects.map(p=>p.phase),solid:boxes.filter(b=>b.solid).map(b=>[b.x,b.z,b.w,b.d]),boxes};
  };
  assert.deepEqual(draw().phases,[]);
  assert.ok(doPlan(world,'p1','granary').ok);
  const base=draw();
  assert.deepEqual(base.phases,['foundation']);
  doBuild(world,'p1');
  const frame=draw();
  assert.deepEqual(frame.phases,['frame']);
  assert.ok(frame.boxes.some(b=>b.rise && b.h>.9));
  doBuild(world,'p1');
  doBuild(world,'p1');
  const complete=draw();
  assert.deepEqual(complete.phases,['complete']);
  assert.deepEqual(complete.solid,base.solid);
  assert.deepEqual(frame.solid,base.solid);
  const old=structuredClone(dumpSurv(sp));
  delete old.survival.buildings[0].lot;
  assert.deepEqual(loadSurv(old).world.survival.buildings[0].lot,constructionLot('yard'));
});


test('住宅使用真实建房和产权记录，竣工前后的外壳、底座和位置一致', async () => {
  const options = GAME_OPTIONS;
  const sp = createSurvPlay(13, options), w = sp.world;
  const draw = play => {
    const view = survView(play), boxes = [];
    const project = addCampWork(boxes, view).find(p => p.record.loc === 'house6');
    const appearance = homeAppearance(view);
    return { project, boxes: boxes.filter(b => b.occluder === 'work:house6:house'),
      homes: outdoorHomes(view, appearance), appearance, view };
  };
  assert.equal(draw(sp).project, undefined);
  const phases = new Map();
  for (let i = 0; i < 240; i++) {
    await tickSurvPlay(sp);
    const state = draw(sp);
    if (!state.project) continue;
    const phase = Object.hasOwn(state.project.record,'progress') ? 'project:' + state.project.phase : 'deed';
    phases.set(phase, state);
    if (phase === 'deed') break;
  }
  assert.deepEqual([...phases.keys()], ['project:foundation','project:frame','project:complete','deed']);
  const foundation = phases.get('project:foundation');
  const shell = phases.get('project:complete');
  const deed = phases.get('deed');
  assert.equal(shell.homes.entrances.house6, undefined);
  assert.ok(deed.homes.entrances.house6);
  assert.equal(deed.view.housing.a3, 'house6');
  assert.deepEqual(shell.boxes, deed.boxes);
  assert.deepEqual(foundation.boxes.filter(b=>b.solid).map(b=>[b.x,b.z,b.w,b.d]),
    deed.boxes.filter(b=>b.solid).map(b=>[b.x,b.z,b.w,b.d]));
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 13, options);
  assert.deepEqual(draw(back).boxes, deed.boxes);
  assert.deepEqual(draw(back).appearance, deed.appearance);
  w.housing.a3 = 'house4';
  assert.ok(!draw(sp).appearance.find(([room])=>room==='house6')[1]);
  w.housing.a2 = 'house6';
  assert.ok(draw(sp).appearance.find(([room])=>room==='house6')[1]);
  w.agents.a2.viab.v = 0;
  settleSurvival(sp);
  const empty = draw(sp);
  assert.ok(!empty.appearance.find(([room])=>room==='house6')[1]);
  assert.deepEqual(empty.boxes, deed.boxes);
});

test('墙体三级、其余建筑双档、储粮四档共同驱动模型键，维修恢复初态', () => {
  const sp = createSurvPlay(7), w = sp.world, s = w.survival;
  const draw = () => {
    const view = survView(sp), boxes = [];
    addCampWork(boxes, view);
    return [workModelKey(view, homeAppearance(view), ''), boxes];
  };
  for (const type of ['wall','shelter','workshop','granary']) {
    s.buildings = [{ type, loc:'yard', integrity:1 }];
    const original = draw();
    s.buildings[0].integrity = .8;
    const light = draw();
    assert.notEqual(light[0],original[0]);
    assert.notDeepEqual(light[1],original[1]);
    s.buildings[0].integrity = .75;
    assert.deepEqual(draw(),light);
    s.buildings[0].integrity = .45;
    if (type==='wall') {
      assert.notEqual(draw()[0],light[0]);
      assert.notDeepEqual(draw()[1],light[1]);
    } else assert.deepEqual(draw(),light);
    w.loc.p1 = 'yard';
    w.pinv.p1 = {wood:1,stone:1};
    assert.ok(doRepair(w,'p1').ok);
    assert.deepEqual(draw(),original);
  }
  const states = [0,3,9,24].map(n=>{s.store=n;return draw();});
  assert.equal(new Set(states.map(([key])=>key)).size,4);
  assert.ok(states.every((state,i)=>i===0 || state[1].length>states[i-1][1].length));
  s.store=23;
  assert.deepEqual(draw(),states.at(-1));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { doBuild, doPlan, BUILDINGS } from './production.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { addCampWork } from '../web/camp-3d-scene.mjs';
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

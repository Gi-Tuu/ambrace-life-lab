import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView } from './survplay.mjs';
import { DAY_TICKS } from './clock.mjs';
import { findRegionEntity, regionEntities } from '../web/camp-region-entities.mjs';
import { wildLandscape } from '../web/wild-landscape.mjs';
import { regionLife } from '../web/camp-3d-scene.mjs';

const options={residentialDecisions:true,settlementLife:true,farmLife:true,ecosystem:true,independentWorld:true};
function world() {
  return createSurvPlay(13,{...options,mapSeed:13,layoutVersion:2});
}
const terrain=wildLandscape(13,2,{joined:true});
const fixtures=Array.from({length:8},(_,i)=>regionEntities(terrain,i-4,4));
test('区域果树和浆果使用同一收获入口及背包，记录随档恢复并按游戏日再生',()=>{
  const sp=world(), w=sp.world;
  const nodes=fixtures.flatMap(c=>c.plants);
  for (const item of ['fruit','berry']) {
    const plant=nodes.find(p=>p.item===item);
    assert.ok(plant);
    assert.deepEqual(findRegionEntity(w,plant.id,'plants'),plant);
    const act={kind:'camp_collect',type:item,tool:'basket',target:plant.id,from:[plant.x,plant.z]};
    assert.equal(survAct(sp,{...act,from:[0,0]}).code,'OUT_OF_REACH');
    assert.ok(survAct(sp,act).ok);
    assert.equal(w.pinv.p1[item],1);
    const restored=loadSurv(structuredClone(dumpSurv(sp)),13,options);
    restored.world.t++;
    assert.equal(survAct(restored,act).code,'NO_PRODUCE');
    w.t+=3*DAY_TICKS;
    assert.ok(survAct(sp,act).ok);
    w.t++;
  }
  assert.equal(Object.keys(survView(sp).regionHarvest).length,2);
  assert.equal(regionLife([{...nodes[0],ready:0,y:2}],[]).gatherables[0].ready,0);
});
test('区域动物沿用同一模型和投喂信任账，伪造来源被拒绝',()=>{
  const sp=world(), w=sp.world;
  const a=fixtures.flatMap(c=>c.animals).find(a=>a.kind!=='bird');
  assert.ok(a);
  const visible=regionLife([],[a]).animals[0];
  assert.equal(visible.id,a.id);
  assert.equal(visible.wild,true);
  w.pinv.p1.berry=2;
  const action={kind:'animal_feed',tool:'basket',target:a.id,from:[a.x+.8,a.z],to:[a.x,a.z]};
  assert.equal(survAct(sp,{...action,target:'region:0:4:9'}).code,'NO_ANIMAL');
  assert.equal(survAct(sp,action).trust,1);
  assert.equal(survAct(sp,action).code,'ANIMAL_WAIT');
  assert.equal(w.pinv.p1.berry,1);
  assert.equal(survView(sp).wildTrust[a.id].trust,1);
});

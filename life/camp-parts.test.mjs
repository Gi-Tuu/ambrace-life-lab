import assert from 'node:assert/strict';
import test from 'node:test';
import { addCampWork, homeAppearance, outdoorHomes, workModelKey } from '../web/camp-3d-scene.mjs';
import { fx3d } from '../web/camp-3d-render.mjs';
import { createSurvPlay, dumpSurv, survView, tickSurvPlay } from './survplay.mjs';

function build(view) {
  const boxes=[], projects=addCampWork(boxes,view);
  return {boxes,projects,homes:outdoorHomes(view,homeAppearance(view))};
}
function fixture() {
  const sp=createSurvPlay(13,{settlementLife:true,residentialDecisions:true,mapSeed:13,layoutVersion:2});
  sp.world.survival.buildings=[
    {loc:'yard',type:'granary',integrity:1},{loc:'garden',type:'workshop',integrity:1},
    {loc:'watch',type:'shelter',integrity:1},{loc:'well',type:'wall',integrity:1},
  ];
  return sp;
}

test('C′ caches reuse geometry within state and rebuild named parts after real state changes',()=>{
  const base=structuredClone(survView(fixture()));
  const view={...base,weather:'clear',store:0};
  let key, cached, rebuilt=0;
  const read=v=>{
    const next=workModelKey(v,homeAppearance(v),'');
    if (next!==key) { cached=build(v); key=next; rebuilt++; }
    return cached;
  };
  const part=(models,type,id)=>models.projects.find(p=>p.record.type===type).parts.get(id);
  const cold=read(view);
  assert.equal(read({...view,t:99}),cold);
  const stocked=read({...view,store:7});
  assert.notEqual(stocked,cold);
  assert.ok(part(stocked,'granary','stock-marker').y>part(cold,'granary','stock-marker').y);
  assert.equal(read({...view,store:8}),stocked);
  const occupied={...view,campPlayerRoom:'facility:garden:workshop'};
  assert.equal(part(cold,'workshop','forge-embers'),undefined);
  assert.equal(part(read(occupied),'workshop','forge-embers').fx,'fire');
  const storm={...view,weather:'rain'};
  assert.ok(part(read(storm),'shelter','storm-shutter-0'));
  assert.equal(read({...storm,weather:'cold'}),cached);
  assert.equal(part(read({...view,campPlayerRoom:'facility:watch:shelter'}),'shelter','hearth-smoke').fx,'smoke');
  const working={...view,occupancy:{garden:['a1']},agents:{...view.agents,a1:{...view.agents.a1,loc:'garden',act:'repair'}}};
  assert.ok(part(read(working),'workshop','forge-embers'));
  assert.equal(part(read({...working,districtTravel:{a1:{to:'well'}}}),'workshop','forge-embers'),undefined);
  assert.equal(rebuilt,7);

  // A cache missing the occupancy dimension returns the cold forge.
  const faulty=new Map();
  const stale=v=>{
    const missing=workModelKey({...v,campPlayerRoom:null},homeAppearance(v),'');
    if (!faulty.has(missing)) faulty.set(missing,build(v));
    return faulty.get(missing);
  };
  stale(view);
  assert.equal(part(stale(occupied),'workshop','forge-embers'),undefined);
  assert.ok(part(build(occupied),'workshop','forge-embers'));
});

test('C′ occupied homes move their shutters and wall damage preserves the three counts',()=>{
  const view=structuredClone(survView(fixture()));
  const room=view.housing.a1, id='work:'+room+':house:shutter-left';
  const occupied=build(view).homes;
  view.agents.a1.dead=true;
  const empty=build(view).homes;
  assert.notEqual(occupied.parts.get(id).x,empty.parts.get(id).x);
  const wall=view.buildings.find(b=>b.type==='wall');
  const counts=[], braces=[];
  for (const integrity of [1,.8,.45]) {
    wall.integrity=integrity;
    const {boxes,projects}=build(view), p=projects.find(p=>p.record.type==='wall');
    counts.push(boxes.filter(b=>b.occluder===p.id).length);
    braces.push(p.parts.get('wall-brace-1').to[1]);
  }
  assert.deepEqual(counts,[24,23,22]);
  assert.ok(braces[2]<braces[0]);
});

test('C′ animation changes rendered vertices without affecting 48 ticks of world state',async()=>{
  const a=fixture(), b=fixture();
  for(let t=0;t<48;t++){
    await tickSurvPlay(a);
    await tickSurvPlay(b);
    const view=survView(a);
    const showcase={...view,buildings:[{loc:'garden',type:'workshop',integrity:1}],campPlayerRoom:'facility:garden:workshop'};
    const fx=build(showcase).boxes.filter(part=>part.fx);
    assert.ok(fx.length);
    const first=[],second=[];
    fx3d(first,fx,0);
    fx3d(second,fx,t%4);
    if(t%4) assert.notDeepEqual(first,second);
    assert.deepEqual(dumpSurv(a),dumpSurv(b));
  }
});

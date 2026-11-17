import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { actuate, move, PLAYER_UNITS_PER_TICK } from './body.mjs';
import { validate } from './rules.mjs';
import { constructionAccess, residentConstructionAccess, siteRecord } from './construction-access.mjs';
import { stepHouseholds, houseLabor } from './households.mjs';
import { clockOf, advanceResidentBusy } from './resident-time.mjs';
import { DAY_TICKS } from './clock.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { overlapsLot, HOUSING_PLOTS } from '../web/camp-layout.mjs';
import { constructionGate } from '../web/camp-construction-access.mjs';

const options = {
  eventRulesVersion:CURRENT_EVENT_RULES, gameRules:true, mapSeed:13, layoutVersion:2, regionalWork:true, settlementLife:true,
  independentWorld:true, residentialDecisions:true, unifiedCooperation:true, actTimeModel:true,
};
const start = () => createSurvPlay(13,options);
const place = 'district-inner-west';
const type = 'shelter';
const found = (sp,loc) => sp.world.survival.sites.find(b=>b.loc===loc);
const key = (loc, type) => `work:${loc}:${type}`;

function gateBlock(w,record) {
  const gate = constructionGate(record,w.campLayout,w.peripheralHomes);
  return {
    type:'wall', loc:'test-blocker', integrity:1,
    lot:{x:gate.x-.55,z:gate.z+.26,w:gate.w+1.1,d:gate.d+.5},
  };
}

function walked(sp,record,entrance=false) {
  const w=sp.world;
  const route=residentConstructionAccess(w,'p1',record);
  assert.equal(route.ok,true,route.code);
  const target=entrance?route.entryPoint:route.workPoint;
  const last=w.survival.playerPos;
  const starting=last?[last.x,last.z]:w.campLayout.sites.hall;
  if (!last) assert.equal(survAct(sp,{kind:'player_sync',from:starting}).ok,true);
  const points=(last || entrance)?[target]:route.route;
  let prev=starting;
  for (const point of points) {
    w.t+=Math.max(1,Math.ceil(Math.hypot(point[0]-prev[0],point[1]-prev[1])/PLAYER_UNITS_PER_TICK));
    assert.ok(survAct(sp,{kind:'player_sync',from:point}).ok);
    prev=point;
  }
  return target;
}

function playerPlan(sp,loc=place,type='shelter') {
  const w=sp.world;
  const record=siteRecord(w,loc,type);
  const from=walked(sp,record);
  w.pinv.p1={wood:8,stone:4};
  const response=survAct(sp,{kind:'plan',type,target:loc,from,tool:'hammer'});
  return { from,record,response };
}

test('seed 13: a disjoint blocker seals the entrance in both core and outskirts',()=>{
  for (const loc of ['yard',place]) {
    const sp=start(), w=sp.world;
    const {lot,...record}=siteRecord(w,loc,type);
    const proposed={...record,lot};
    const from=walked(sp,proposed);
    const blocker=gateBlock(w,proposed);
    assert.ok(!overlapsLot(lot,blocker.lot,.35));
    w.survival.buildings.push(blocker);
    w.pinv.p1={wood:8,stone:4};
    const r=survAct(sp,{kind:'plan',type,target:loc,from,tool:'hammer'});
    assert.equal(r.code,'BUILD_ENTRANCE_BLOCKED');
    assert.equal(found(sp,loc),undefined);
    assert.deepEqual(w.pinv.p1,{wood:8,stone:4});
    assert.equal(survView(sp).settlementEvents.at(-1).reason,'BUILD_ENTRANCE_BLOCKED');
    move(w,'a1',loc);
    assert.equal(validate(w,'a1',{kind:'plan',type}).code,'BUILD_ENTRANCE_BLOCKED');
  }
});

test('outskirts: valid travel, blocked progress and recovered work through normal actions',async()=>{
  const sp=start(), w=sp.world;
  const {from,record,response}=playerPlan(sp);
  assert.equal(response.ok,true,response.code);
  assert.equal(found(sp,place).progress,0);
  assert.deepEqual(w.pinv.p1,{wood:0,stone:0});
  assert.equal(survAct(sp,{kind:'build',target:key(place,type),from}).ok,true);
  assert.equal(found(sp,place).progress,2);

  const travel=actuate(w,'a1',{kind:'move_to',to:place});
  assert.equal(travel.ok,true,travel.code);
  const trip=w.survival.districtTravel.a1;
  assert.ok(trip.arrive>w.t && Array.isArray(trip.at));
  assert.notEqual(w.loc.a1,place);
  assert.equal(actuate(w,'a1',{kind:'build'}).ok,false);
  for (const agent of Object.values(w.agents)) if (!agent.isPlayer) agent.tick=async()=>{};
  while(w.t<trip.arrive) await tickSurvPlay(sp);
  assert.equal(w.loc.a1,place);
  assert.deepEqual(survView(sp).constructionArrivals.a1,trip.at);

  const a=w.agents.a1;
  a.drives.v.energy=1;
  clockOf(w,'a1').tick.usedMin=45;
  assert.equal(a.execute(w,{kind:'build'},'test',w.t,true).code,'BUSY_START');
  w.survival.buildings.push(gateBlock(w,record));
  w.t++;
  assert.equal(advanceResidentBusy(w,'a1').code,'BUILD_ENTRANCE_BLOCKED');
  assert.equal(found(sp,place).progress,2);
  assert.equal(survAct(sp,{kind:'build',target:key(place,type),from}).code,'BUILD_ENTRANCE_BLOCKED');
  assert.equal(found(sp,place).progress,2);
  assert.ok(survView(sp).settlementEvents.some(e=>e.kind==='work_interrupted'&&e.actor==='a1'));

  w.survival.buildings.pop();
  assert.equal(a.execute(w,{kind:'build'},'test',w.t,true).ok,true);
  assert.equal(found(sp,place).progress,4);
  for (let i=0;i<3;i++) assert.ok(survAct(sp,{kind:'build',target:key(place,type),from}).ok);
  assert.equal(found(sp,place),undefined);
  assert.ok(w.survival.buildings.find(b=>b.loc===place&&b.type===type));
  const loaded=loadSurv(structuredClone(dumpSurv(sp)),13,options);
  assert.ok(constructionAccess(loaded.world,record).ok);
  const entry=walked(loaded,record,true);
  const room=`facility:${place}:${type}`;
  assert.equal(survAct(loaded,{kind:'move',room,entrance:true,from:entry}).ok,true);
  assert.equal(loaded.world.campPlayerRoom,room);
  assert.equal(survAct(loaded,{kind:'camp_exit'}).ok,true);
  assert.equal(loaded.world.campPlayerRoom,null);
});

test('private house: resident chooses a reachable peripheral plot, works there and gains a deed',async()=>{
  const sp=start(), w=sp.world;
  const h=w.survival.households;
  for (const room of Object.keys(HOUSING_PLOTS)) h.deeds[room]={owner:'a2'};
  const id='a1';
  delete w.housing[id];
  h.residents[id].decision='seeking';
  w.pinv[id]={wood:5,stone:3};
  stepHouseholds(w,[]);
  const [room,project]=Object.entries(h.projects).find(([,p])=>p.owner===id)??[];
  assert.ok(w.peripheralHomes[room]);
  assert.equal(project.progress,0);
  assert.deepEqual(w.pinv[id],{wood:0,stone:0});
  assert.equal(houseLabor(w,id,true),false);
  assert.equal(actuate(w,id,{kind:'move_to',to:room}).ok,true);
  const arrive=w.survival.districtTravel[id].arrive;
  for (const agent of Object.values(w.agents)) if (!agent.isPlayer) agent.tick=async()=>{};
  while(w.t<arrive) await tickSurvPlay(sp);
  assert.equal(w.loc[id],room);
  for (let i=0;i<3;i++) {
    assert.equal(validate(w,id,{kind:'house_work'}).ok,true);
    assert.equal(actuate(w,id,{kind:'house_work'}).ok,true);
    w.t+=DAY_TICKS;
  }
  stepHouseholds(w,[]);
  assert.equal(h.deeds[room].owner,id);
  assert.equal(w.housing[id],room);
  assert.equal(h.projects[room],undefined);
  move(w,id,'hall');
  assert.equal(actuate(w,id,{kind:'move_to',to:room}).ok,true);
  assert.ok(w.survival.districtTravel[id].at);
});

test('seed 13: distinguish a missing work position from a severed approach route',()=>{
  for (const [gap,type,code] of [[.46,'wall','BUILD_WORK_BLOCKED'],[3,'shelter','BUILD_PATH_BLOCKED']]) {
    const sp=start(), w=sp.world;
    const record=siteRecord(w,place,type);
    const {x,z,w:width,d}=record.lot;
    const enclosure=[
      {x:x-gap-1,z:z-gap-1,w:1,d:d+2*gap+2},
      {x:x+width+gap,z:z-gap-1,w:1,d:d+2*gap+2},
      {x:x-gap-1,z:z-gap-1,w:width+2*gap+2,d:1},
      {x:x-gap-1,z:z+d+gap,w:width+2*gap+2,d:1},
    ];
    const from=walked(sp,record);
    for (const [i,lot] of enclosure.entries()) {
      assert.ok(!overlapsLot(record.lot,lot,.35));
      w.survival.buildings.push({loc:`fixture-${i}`,type:'wall',lot,integrity:1});
    }
    w.pinv.p1={wood:12,stone:12};
    assert.equal(survAct(sp,{kind:'plan',type,target:place,from,tool:'hammer'}).code,code);
    assert.equal(found(sp,place),undefined);
    assert.deepEqual(w.pinv.p1,{wood:12,stone:12});
  }
});

test('an en-route resident cannot be declared on site after the entrance closes', async()=>{
  const sp=start(), w=sp.world;
  const {record,response}=playerPlan(sp);
  assert.equal(response.ok,true,response.code);
  assert.equal(actuate(w,'a1',{kind:'move_to',to:place}).ok,true);
  const arrival=w.survival.districtTravel.a1.arrive;
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.tick=async()=>{};
  w.survival.buildings.push(gateBlock(w,record));
  while (w.t<arrival) await tickSurvPlay(sp);
  assert.notEqual(w.loc.a1,place);
  assert.equal(found(sp,place).progress,0);
  assert.ok(survView(sp).settlementEvents.some(e=>e.actor==='a1'&&e.action==='move_to'&&e.reason==='BUILD_ENTRANCE_BLOCKED'));
  w.survival.buildings.pop();
  assert.equal(actuate(w,'a1',{kind:'move_to',to:place}).ok,true);
  while(w.survival.districtTravel.a1) await tickSurvPlay(sp);
  assert.equal(w.loc.a1,place);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { BUILDINGS, buildLot, regenResources } from './production.mjs';
import { residentContact } from './camp-play.mjs';
import { campDistricts, districtPads } from '../web/camp-districts.mjs';
import { addCampWork, homeAppearance, outdoorHomes } from '../web/camp-3d-scene.mjs';
import { facilityId } from '../web/camp-facility.mjs';
import { joinedRoute } from '../web/camp-outskirts.mjs';
import { inCamp, wildLandscape } from '../web/wild-landscape.mjs';

import { houseLabor, stepHouseholds } from './households.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { move } from './body.mjs';
import { DAY_TICKS } from './clock.mjs';
import { HOUSING_PLOTS } from '../web/camp-layout.mjs';

const options={mapSeed:13,layoutVersion:2,settlementLife:true,regionalWork:true,independentWorld:true,
  wildFood:true,residentialDecisions:true,unifiedCooperation:true,autonomousGoals:true};
const start=()=>createSurvPlay(13,options);
const copy=sp=>loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))),13,options);

test('peripheral lots use the same cost, work phases, repair, facility, and save', () => {
  let sp=start(), w=sp.world;
  const loc='district-west', d=w.districts[loc], from=[d.at[0]+.5,d.at[1]-.35];
  assert.ok(from[0]<0);
  // P0-1 改量披露：外围动作现需服务端玩家位置连续性校验。本测试聚焦地块成本/工phase/维修/设施，
  // 故每次动作前重立"玩家已合法步行到该区"（playerPos 留足步行余量）；瞬移拒绝由 V4-01 闸门专测。断言未放宽。
  const act=(kind,body)=>{ w.survival.playerPos={x:from[0],z:from[1],t:w.t-100}; return survAct(sp,{kind,...body}); };
  const next=()=>{w.t++;};
  const plan={target:loc,tool:'hammer',type:'granary',from};
  assert.equal(act('plan',{...plan,from:[10,20]}).code,'OUT_OF_REACH');
  assert.equal(act('plan',{...plan,tool:'hand'}).code,'NEED_TOOL');
  assert.equal(act('plan',plan).code,'NO_MATERIAL');
  const harvest={target:loc,tool:'axe',from:d.source};
  assert.equal(act('gather',{...harvest,from}).code,'OUT_OF_REACH');
  assert.equal(act('gather',harvest).ok,true);
  assert.equal(w.pinv.p1.wood,2);
  assert.equal(w.survival.resStock[loc],d.capacity-2);
  regenResources(w);
  assert.equal(w.survival.resStock[loc],d.capacity-1);
  next();
  Object.assign(w.pinv.p1,BUILDINGS.granary.cost);
  assert.equal(act('plan',plan).ok,true);
  assert.deepEqual([w.pinv.p1.wood,w.pinv.p1.stone],[0,0]);
  const phase=()=>addCampWork([],survView(sp)).find(p=>p.record.loc===loc);
  assert.equal(phase().phase,'foundation');
  next();
  assert.equal(act('plan',plan).code,'OCCUPIED');
  sp=copy(sp);w=sp.world;
  assert.equal(w.survival.resStock[loc],d.capacity-1);
  const target='work:'+loc+':granary';
  assert.equal(act('build',{target,from:[5,25]}).code,'OUT_OF_REACH');
  for (const expected of ['frame','frame','complete']) {
    assert.equal(act('build',{target,from}).ok,true);
    assert.equal(phase().phase,expected);
    next();
  }
  assert.equal(survView(sp).storeCap,36);
  const built=w.survival.buildings.find(b=>b.loc===loc), {gate}=phase(), room=facilityId(built);
  const gatePoint=[gate.x+gate.w/2,gate.z+gate.d*.8];
  assert.equal(act('move',{room,entrance:true,from:[4,40]}).code,'OUT_OF_REACH');
  assert.equal(act('move',{room,entrance:true,from:gatePoint}).ok,true);
  assert.equal(act('facility_use',{target:room,type:'deposit'}).code,'EMPTY');
  w.pinv.p1.crop=1;
  const store=w.survival.store;
  assert.equal(act('facility_use',{target:room,type:'deposit'}).ok,true);
  assert.equal(w.survival.store,store+1);
  assert.equal(act('camp_exit',{}).ok,true);
  next();
  assert.equal(act('build',{}).code,'OUT_OF_REACH');
  built.integrity=.45;
  Object.assign(w.pinv.p1,{wood:1,stone:1});
  assert.equal(act('repair',{target,from}).ok,true);
  assert.equal(built.integrity,1);
  assert.deepEqual(copy(sp).world.survival.buildings,[built]);
});

test('resident decisions travel to peripheral sources when village supplies run dry', async () => {
  let sp=start(), w=sp.world;
  Object.assign(w.survival.resStock,{yard:0,garden:0,watch:0,well:0});
  let outbound, gathered;
  const previous={...w.survival.resStock};
  for (let i=0;i<23;i++) {
    await tickSurvPlay(sp);
    if (!outbound) {
      const entry=Object.entries(w.survival.districtTravel??{}).find(([,trip])=>w.districts[trip.to]);
      if (entry) {
        const [id,trip]=entry;
        assert.equal(w.loc[id],trip.from);
        assert.ok(trip.arrive>w.t);
        assert.equal(w.occupancy[trip.to]?.includes(id)??false,false);
        sp=copy(sp);w=sp.world;
        assert.deepEqual(w.survival.districtTravel[id],trip);
        outbound=entry;
      }
    }
    if (outbound && Object.keys(w.districts).some(loc=>w.survival.resStock[loc]<previous[loc])) {
      gathered=true;break;
    }
  }
  assert.ok(outbound,'a resident chose a distant destination');
  assert.ok(gathered,'a resident arrived and consumed real resource stock');
  const [id]=outbound;
  const [x,z]=w.districts[outbound[1].to].at;
  if (w.loc[id]===outbound[1].to)
    assert.equal(residentContact(w,{target:id,room:null,from:[x,z],to:[x,z+.4]}),null);
  assert.equal(w.survival.agentErrors??0,0);
});

test('seeded terrain keeps peripheral pads clear and routes through the common bridge', () => {
  const sp=start(), w=sp.world;
  const places=w.districts, flats=districtPads(places);
  const terrain=wildLandscape(w.mapSeed,w.layoutVersion,{joined:true,flats,clearing:flats});
  const crossing=w.campLayout.crossZ, allows=(x,z)=>terrain.walkable(x,z,crossing);
  assert.deepEqual(campDistricts(13,2),places);
  assert.notDeepEqual(campDistricts(7,2),places);
  assert.equal(Object.keys(places).length,10);
  for (const {at,source,lot} of Object.values(places)) {
    assert.equal(inCamp(...at),false);
    assert.ok(allows(...at));
    assert.ok(allows(...source));
    assert.ok(Math.abs(terrain.height(lot.x,lot.z))<.01);
    assert.ok(Math.abs(terrain.height(lot.x+lot.w,lot.z+lot.d))<.01);
  }
  const from=places['district-west'].at, to=places['district-east'].at;
  const route=joinedRoute(from,to,(x,z)=>allows(x,z) && !(x>-16 && x<-9 && z>31 && z<38));
  assert.ok(route?.length>1);
  assert.deepEqual(route?.at(-1),to);
  assert.ok([from,...route].slice(1).some((b,i)=>{
    const a=[from,...route][i];
    return Array.from({length:Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])*4)+1},(_,j)=>j).some((j,_,steps)=>
      terrain.isBridge(a[0]+(b[0]-a[0])*j/steps.length,a[1]+(b[1]-a[1])*j/steps.length,crossing));
  }));
  for (const point of route) assert.ok(allows(...point));
});

test('the existing cooperation loop can select and finish an exterior site', async () => {
  const sp=createSurvPlay(7,{...options,mapSeed:7}), w=sp.world, s=w.survival;
  for (const loc of w.outdoor.filter(loc=>!w.districts[loc])) {
    s.buildings.push({type:'wall',loc,lot:buildLot(w,loc),integrity:1,at:w.campLayout.sites[loc]});
  }
  Object.assign(s.inv,{wood:25,stone:25});
  let departed=false, founded=false, completed;
  for (let i=0;i<80 && !completed;i++) {
    await tickSurvPlay(sp);
    departed ||= Object.values(s.districtTravel??{}).some(t=>w.districts[t.to]);
    founded ||= s.sites.some(b=>w.districts[b.loc]);
    completed=s.buildings.find(b=>w.districts[b.loc]);
  }
  assert.ok(departed && founded && completed);
  assert.ok(Object.keys(completed.contributors).some(id=>id!=='p1'));
  assert.equal(s.agentErrors??0,0);
});

test('private exterior home uses the same deed, stages, door and road rules', () => {
  const optionsV4={...options,eventRulesVersion:CURRENT_EVENT_RULES};
  let sp=createSurvPlay(13,optionsV4), w=sp.world, h=w.survival.households;
  for (const room of Object.keys(HOUSING_PLOTS)) h.deeds[room]??={owner:'a2'};
  h.deeds.house5={owner:'a2'};
  for (const id of ['a2','a3']) h.residents[id].decision='stayed';
  Object.assign(w.pinv.a1,{wood:5,stone:3});
  stepHouseholds(w,sp.log);
  const room=Object.keys(h.projects)[0];
  assert.ok(w.peripheralHomes[room]);
  assert.deepEqual([w.pinv.a1.wood,w.pinv.a1.stone],[0,0]);
  const projects=()=>addCampWork([],survView(sp)).filter(p=>p.record.loc===room);
  assert.equal(projects()[0].phase,'foundation');
  assert.equal(houseLabor(w,'a1',true),false);
  move(w,'a1',room);
  for (let i=0;i<3;i++) {
    assert.ok(houseLabor(w,'a1',true));
    assert.equal(houseLabor(w,'a1',true),false);
    w.t+=DAY_TICKS;
  }
  stepHouseholds(w,sp.log);
  assert.equal(h.deeds[room].owner,'a1');
  assert.equal(w.housing.a1,room);
  assert.deepEqual(projects().map(p=>p.phase),['complete']);
  sp=loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))),13,optionsV4); w=sp.world;
  assert.equal(w.housing.a1,room);
  const view=survView(sp), {entrances}=outdoorHomes(view,homeAppearance(view));
  const gate=entrances[room], from=[gate.x+gate.w/2,gate.z+gate.d*.6];
  const enter={kind:'move',room,entrance:true,from};
  assert.equal(survAct(sp,enter).code,'HOME_LOCKED');
  assert.ok(survAct(sp,{kind:'home_break',room,tool:'hammer',from}).ok);
  assert.ok(survAct(sp,enter).ok);
  assert.ok(survAct(sp,{kind:'camp_exit'}).ok);
  w.t++;
  assert.equal(survAct(sp,{kind:'road_lay',room,from}).code,'NO_AUTHORITY');
  w.housing.p1=room;
  w.pinv.p1.stone=1;
  assert.ok(survAct(sp,{kind:'road_lay',room,from}).ok);
  assert.equal(w.survival.homeRoads[room].present,true);
  w.t+=DAY_TICKS*4;
  assert.ok(survAct(sp,{kind:'road_remove',room,from}).ok);
  assert.equal(w.survival.homeRoads[room].present,false);
});

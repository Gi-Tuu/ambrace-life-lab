import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { campEntrance, campPen, campSite, wildHabitats } from '../web/camp-interaction.mjs';
import { generateCampLayout, overlapsLot } from '../web/camp-layout.mjs';
import { roadCandidate } from './home-roads.mjs';
import { move } from './body.mjs';
import { DAY_TICKS } from './clock.mjs';

const options={residentialDecisions:true,settlementLife:true,farmLife:true,ecosystem:true,independentWorld:true};
const make=()=>createSurvPlay(7,{...options,mapSeed:7,layoutVersion:2});

test('第二版种子决定住宅实际位置，保持不重叠并能精确恢复',()=>{
  const sp=make();
  const a=generateCampLayout(7,2), b=generateCampLayout(42,2);
  assert.notDeepEqual(a.sites.house1,b.sites.house1);
  assert.notDeepEqual(a.sites.house2,a.sites.house3);
  assert.notDeepEqual(a.sites.house1,generateCampLayout(7,1).sites.house1);
  for (let seed=1;seed<=200;seed++) {
    const l=generateCampLayout(seed,2);
    const parcels=Object.entries(l.sites).filter(([k])=>k.startsWith('house')).map(([, [x,z]])=>({x:x-3.15,z:z-6.5,w:6.3,d:6.8}));
    for (const [i,p] of parcels.entries()) assert.ok(parcels.slice(i+1).every(q=>!overlapsLot(p,q)));
  }
  const loaded=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.equal(loaded.world.layoutVersion,2);
  assert.deepEqual(loaded.world.campLayout,a);
});

test('住户可拆路、间隔后用石料复铺，独居偏好可产生道路行动',()=>{
  const sp=make(),w=sp.world, room=w.housing.p1;
  const gate=campEntrance(room,campSite(room,w.campLayout));
  const from=[gate.x+gate.w/2,gate.z+gate.d/2];
  const attempt=kind=>survAct(sp,{kind,room,from});
  assert.ok(attempt('road_remove').ok);
  assert.equal(w.survival.homeRoads[room].present,false);
  assert.equal(attempt('road_lay').code,'ACTION_BUDGET');
  w.t+=4*DAY_TICKS;
  assert.equal(attempt('road_lay').code,'NO_MATERIAL');
  w.pinv.p1.stone=1;
  assert.ok(attempt('road_lay').ok);
  assert.equal(w.pinv.p1.stone,0);
  move(w,'a3',w.housing.a3);
  w.agents.a3.drives.v.energy=.9;
  w.agents.a3.drives.v.social=.9;
  assert.equal(roadCandidate(w,'a3').kind,'road_remove');
  assert.deepEqual(survView(loadSurv(structuredClone(dumpSurv(sp)),7,options)).homeRoads,w.survival.homeRoads);
});

test('野生动物投喂消耗食物，至少间隔半天，鸟类有独立来源',()=>{
  const sp=make(),w=sp.world;
  const [animal]=wildHabitats(w.campLayout);
  assert.ok(wildHabitats(w.campLayout).some(a=>a.kind==='bird'));
  const from=[animal.x,animal.z+1.25], to=[animal.x,animal.z];
  const attempt=()=>survAct(sp,{kind:'animal_feed',tool:'basket',target:animal.id,from,to});
  assert.equal(attempt().code,'ANIMAL_NEEDS_FOOD');
  w.pinv.p1.berry=4;
  for (let i=1;i<=4;i++) {
    assert.equal(attempt().trust,i);
    if (i<4) assert.equal(attempt().code,'ANIMAL_WAIT');
    w.t+=Math.ceil(DAY_TICKS/2);
  }
  assert.equal(w.pinv.p1.berry,0);
  const loaded=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.equal(survView(loaded).wildTrust[animal.id].trust,4);
});

test('同圈屠宰触发停产和繁衍抑制，恐惧期肉量下降且随档恢复',async()=>{
  const sp=make(),w=sp.world,s=w.survival;
  const pen=campPen(campSite('yard',w.campLayout)), to=[pen.x+2,pen.z+3],from=[to[0]+.75,to[1]];
  const cull=target=>survAct(sp,{kind:'animal_slaughter',tool:'axe',target,from,to});
  assert.equal(cull('cows:0').meat,6);
  const frightened=survView(sp).ecoSources.milk[0];
  assert.equal(frightened.id,'cows:1');
  assert.equal(frightened.afraid,true);
  w.t+=1;
  assert.equal(cull('cows:1').meat,3);
  assert.equal(w.pinv.p1.meat,9);
  assert.equal(s.livestock.cows,0);
  const restored=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.ok(survView(restored).ecoSources.egg.every(c=>c.afraid));
  assert.equal(survView(restored).ecoSources.milk.length,0);
  const num=s.livestock.chickens;
  w.t=DAY_TICKS-1;
  await tickSurvPlay(sp);
  assert.equal(s.livestock.chickens,num);
  assert.equal(s.produce.egg,0);
  assert.equal(s.produce.wool,0);
  w.t=3*DAY_TICKS;
  assert.ok(survView(sp).ecoSources.egg.every(c=>!c.afraid));
});

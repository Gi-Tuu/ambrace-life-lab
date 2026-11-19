import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, settleSurvival, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { stepRelationships, infantDaysFor, adultDaysFor, elderDaysFor } from './households.mjs';
import { DAY_TICKS } from './clock.mjs';
import { actorBoxes } from '../web/camp-3d-render.mjs';
import { residentLook } from '../web/resident-look.mjs';
import { residentPortraitFaces } from '../web/resident-portrait.mjs';

test('真实出生和跨档成长更新四阶段头像，同时保留居民配色和发型特征',async()=>{
  const options={residentialDecisions:true};
  let sp=createSurvPlay(7,options);
  const w=sp.world,{a1,a2}=w.agents;
  w.survival.endFreeze=false;
  for (const [one,other] of [[a1,a2],[a2,a1]]) {
    Object.assign(one.relations.get(other.id),{trust:65,familiarity:.8});
  }
  stepRelationships(w,sp.log);
  w.t+=DAY_TICKS;
  stepRelationships(w,sp.log);
  w.survival.buildings.push({type:'shelter',loc:'yard',integrity:1});
  w.survival.store=26;
  w.t=DAY_TICKS*2-1;
  await tickSurvPlay(sp);
  const newborn=survView(sp).agents.c1;
  assert.equal(newborn.stage,'infant');
  const portrait=residentPortraitFaces(newborn);
  assert.ok(portrait.length>15 && portrait.every(face=>face.points.flat().every(Number.isFinite)));
  const adultPortrait=residentPortraitFaces({...newborn,stage:'adult'});
  assert.ok(portrait.length<adultPortrait.length,'襁褓头像使用婴儿几何');
  sp=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.deepEqual(residentPortraitFaces(survView(sp).agents.c1),portrait);
  const copy=sp.world,born=copy.survival.households.residents.c1.born;
  const signatures=new Set([JSON.stringify(portrait)]);
  const identity=residentLook(newborn);
  for (const [days,stage] of [[infantDaysFor(copy),'child'],[adultDaysFor(copy),'adult'],[elderDaysFor(copy,'c1'),'elder']]) {
    copy.t=born+days*DAY_TICKS;
    const resident=survView(sp).agents.c1, look=residentLook(resident);
    assert.equal(resident.stage,stage);
    assert.equal(look.shirt,identity.shirt);
    assert.equal(look.style,identity.style);
    assert.equal(look.face,identity.face);
    if (stage==='elder') assert.notEqual(look.hair,look.naturalHair);
    signatures.add(JSON.stringify(residentPortraitFaces(resident)));
  }
  assert.equal(signatures.size,4);
  const roster=Array.from({length:12},(_,i)=>residentLook({id:'c'+(i+1),stage:'adult'}));
  assert.ok(new Set(roster.map(a=>a.style)).size>=3);
  assert.equal(new Set(roster.map(a=>a.coat)).size,3);
});

test('真实打伤后可读轻重伤，恢复后旧伤不会因掉存续再出现',()=>{
  const options={residentialDecisions:true};
  const sp=createSurvPlay(7,options),w=sp.world,npc=w.agents.a1;
  const hit={kind:'camp_resident',target:'a1',room:null,tool:'hammer',from:[21.4,24.5],to:[22.5,24.5]};
  const view=()=>survView(sp).agents.a1;
  npc.viab.v=.67;
  assert.equal(view().injury,null);
  assert.equal(survAct(sp,hit).code,'RESIDENT_HURT');
  assert.equal(view().injury,'critical');
  assert.equal(survAct(sp,hit).code,'RESIDENT_COOLDOWN');
  const portrait=residentPortraitFaces(view());
  const saved=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.deepEqual(residentPortraitFaces(survView(saved).agents.a1),portrait);
  const body={x:1,y:0,z:1,who:'a1',stage:'adult',direction:'down',moving:true};
  const regular=actorBoxes(body,1), hurt=actorBoxes({...body,injury:view().injury},1);
  const height=boxes=>Math.max(...boxes.map(box=>box.y+box.h));
  assert.ok(height(hurt)<height(regular));
  assert.ok(hurt.some(b=>b.color==='#EBD9B5'));
  assert.notDeepEqual(hurt.filter(b=>b.color==='#324D59'),regular.filter(b=>b.color==='#324D59'));
  assert.equal(Math.min(...hurt.map(b=>b.y)),0,'受伤弯身保持脚底贴地');
  npc.viab.regen(.5);
  settleSurvival(sp);
  assert.equal(view().injury,'hurt');
  npc.viab.regen(.5);
  settleSurvival(sp);
  assert.equal(view().injury,null);
  assert.notDeepEqual(residentPortraitFaces(view()),portrait);
  npc.viab.v=.53;
  assert.equal(view().injury,null);
  w.survival.campWounds.a1={t:w.t,total:.14};
  assert.equal(view().injury,'critical','旧档兼容原受伤时段');
  w.t+=2;
  assert.equal(view().injury,null);
});

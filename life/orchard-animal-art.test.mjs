import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView } from './survplay.mjs';
import { restoreSources } from './source-produce.mjs';
import { stepEcosystem } from './ecology.mjs';
import { DAY_TICKS } from './clock.mjs';
import { animalBoxes, boxVertices } from '../web/camp-3d-render.mjs';
import { animalMeals } from '../web/camp-animal-motion.mjs';
import { campSite, wildHabitats } from '../shared/camp-interaction.mjs';
import { orchardWeather } from '../shared/camp-orchard-look.mjs';
import { outdoorLife, regionLife } from '../shared/camp-scene.mjs';

function ecologyDay(world) {
  stepEcosystem(world);
  restoreSources(world);
}

const options={gameRules:true,farmLife:true,settlementLife:true,independentWorld:true,ecosystem:true,mapSeed:7,layoutVersion:2};
const plantStage=view=>outdoorLife({...view,sites:{yard:campSite('yard',view.layout)},tw:90,th:80});
const fruitNode=(stage,id)=>stage.gatherables.find(p=>p.id===id);
const fruitCount=(stage,id)=>stage.boxes.filter(b=>b.occluder===id && b.color==='#CF4E53').length;

test('初春花苞和盛花与实际挂果并存，风暴断枝随健康修复并可读档',()=>{
  const sp=createSurvPlay(7,options), w=sp.world,s=w.survival;
  const first=survView(sp).ecoSources.fruit[0],id=first.id;
  s.standing.fruit[id]=2;s.produce.fruit=2;
  const bud=plantStage(survView(sp));
  assert.equal(fruitNode(bud,id).appearance.bloom,'bud');
  assert.equal(fruitCount(bud,id),2);
  w.t=5*DAY_TICKS;
  const full=plantStage(survView(sp));
  assert.equal(fruitNode(full,id).appearance.bloom,'full');
  assert.ok(full.boxes.filter(b=>b.color==='#F3C3C5').length>0);
  assert.equal(fruitCount(full,id),2);
  const young=regionLife([{x:4,z:4,id:'new',item:'fruit',mature:false,ready:0}],[],orchardWeather(survView(sp)));
  assert.equal(fruitNode(young,'new').appearance.bloom,null);
  s.disasterToday='storm';ecologyDay(w);
  const storm=plantStage(survView(sp));
  assert.equal(fruitNode(storm,id).appearance.damage,2);
  assert.ok(storm.boxes.some(b=>b.occluder===id && b.shape==='beam'),'broken branch is visible on the affected tree');
  const copy=loadSurv(structuredClone(dumpSurv(sp)),7,options);
  assert.equal(fruitNode(plantStage(survView(copy)),id).appearance.damage,2);
  s.disasterToday=null;w.t+=DAY_TICKS;
  assert.equal(fruitNode(plantStage(survView(sp)),id).appearance.damage,2,'damage outlasts the storm');
  s.water=1;
  for (let i=0;i<10;i++) { w.t+=DAY_TICKS;ecologyDay(w); }
  const recovered=plantStage(survView(sp));
  assert.equal(fruitNode(recovered,id).appearance.damage,0);
  assert.equal(fruitNode(recovered,id).appearance.bloom,null);
  assert.equal(recovered.boxes.some(b=>b.occluder===id && b.shape==='beam'),false);
  const frozen=regionLife([{x:4,z:4,id:'wild',item:'fruit',ready:1}],[],
    orchardWeather({season:'春',dayInSeason:6,disasterToday:'coldsnap'}));
  assert.equal(fruitNode(frozen,'wild').appearance.frost,true);
  assert.equal(fruitNode(frozen,'wild').appearance.bloom,null);
  assert.equal(fruitCount(frozen,'wild'),1);
  const dry=regionLife([{x:4,z:4,id:'wild',item:'fruit',ready:1}],[],orchardWeather({drought:true}));
  assert.ok(dry.boxes.some(b=>b.color==='#777647'));
});

test('进食只接收最新的成功投喂和实际鸡粮结算，同一快照无重复、A/B 不串播',()=>{
  const sp=createSurvPlay(7,options),w=sp.world,s=w.survival;
  const animal=wildHabitats(w.campLayout).find(a=>a.kind==='rabbit');
  const body={kind:'animal_feed',target:animal.id,tool:'basket',from:[animal.x+.7,animal.z],to:[animal.x,animal.z]};
  s.playerPos={x:body.from[0],z:body.from[1],t:w.t};
  const play=animalMeals(), other=animalMeals();
  play('A',survView(sp),0); other('B',survView(sp),0);
  assert.equal(survAct(sp,body).code,'ANIMAL_NEEDS_FOOD');
  assert.equal(play('A',survView(sp),.2).size,0);
  w.pinv.p1.berry=1;
  assert.equal(survAct(sp,body).ok,true);
  const fed=survView(sp);
  assert.equal(play('A',fed,.3).get(animal.id),0);
  assert.equal(other('B',{...fed,wildTrust:{}},.3).size,0);
  assert.equal(animalMeals()('restored',fed,1).size,0);
  assert.ok(play('A',survView(sp),.9).get(animal.id)>0);
  assert.equal(play('A',survView(sp),2).size,0);
  w.t+=DAY_TICKS;s.store=0;s.produce.berry=0;s.produce.fruit=0;
  ecologyDay(w);
  assert.equal(survView(sp).chickenMeal,null);
  s.produce.berry=5;w.t+=DAY_TICKS;
  ecologyDay(w);
  const withFeed=survView(sp);
  assert.ok(withFeed.chickenMeal.ids.includes('chickens:ch1'));
  assert.equal(play('A',withFeed,3).get('chickens:ch1'),0);
});

test('警觉、进食和啃草使用附着的头部零件，动作不改变脚下边界或穿进地面',()=>{
  const stage=outdoorLife({sites:{yard:[15,21]},livestock:{chickens:1,cows:1,sheep:1}});
  const world=regionLife([],['rabbit','deer','fox'].map((kind,i)=>({kind,id:kind,x:10+i*2,z:20})));
  const isHead=b=>b.fx==='head' || b.fx==='nod';
  const vertical=boxes=>boxes.filter(isHead).flatMap(b=>boxVertices(b)).map(p=>p[1]);
  for (const animal of [...stage.animals,...world.animals]) {
    const a={...animal,groundY:2,direction:1,phase:0};
    const neutral=animalBoxes(a,.87), alert=animalBoxes({...a,alert:true,watch:[a.x+1,a.z]},.87);
    const feeding=animalBoxes({...a,...(a.kind==='cows'||a.kind==='sheep'?{graze:true}:{meal:.47})},.87);
    assert.ok(Math.max(...vertical(alert))>Math.max(...vertical(neutral)),animal.kind);
    assert.ok(Math.min(...vertical(feeding))<Math.min(...vertical(neutral)),animal.kind);
    assert.ok(Math.min(...vertical(feeding))>=a.groundY,animal.kind);
    assert.deepEqual(feeding.filter(b=>b.fx==='leg'),neutral.filter(b=>b.fx==='leg'));
    assert.ok(feeding.filter(isHead).every(b=>b.rot));
  }
});

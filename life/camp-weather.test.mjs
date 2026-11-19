import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView } from './survplay.mjs';
import { advanceSurvival, stormOn } from './worldstate.mjs';
import { doRepair } from './production.mjs';
import { DAY_TICKS } from './clock.mjs';
import { addCampWork, outdoorLife } from '../shared/camp-scene.mjs';
import { campClimate, plotWeather, stormEffects } from '../web/camp-weather.mjs';

const options={gameRules:true, independentWorld:true, farmLife:true};
const beds=view=>view.plots.map(({bed,...p})=>({...p,x:bed.x*16,y:bed.z*16,w:bed.w*16,h:bed.d*16}));
const geometry=view=>outdoorLife({beds:plotWeather(view,beds(view)), sites:view.layout?.sites??{garden:[31,39],yard:[20,34]},
  tw:120,th:80,trees:[],layout:view.layout,livestock:view.livestock}).boxes;

test('预警与普通降雨无风暴粒子，真实风暴在世界表面产生水花与飞叶，风暴结束即停',()=>{
  const sp=createSurvPlay(7,options), w=sp.world,s=w.survival;
  const day=Array.from({length:100},(_,n)=>n).find(n=>stormOn(n,null,7));
  w.t=(day-1)*DAY_TICKS; s.disasters=true;
  const forecast=survView(sp);
  assert.equal(forecast.stormTomorrow,true);
  assert.equal(campClimate({...forecast,weather:'rain'}).storm,false);
  s.plots[0].growth=.78;
  s.buildings=[{type:'wall',loc:'well',integrity:1,lot:{x:40,z:24,w:5,d:2.5}}];
  const intact=[];
  addCampWork(intact,survView(sp),[]);
  w.t+=DAY_TICKS;
  advanceSurvival(w);
  const active=survView(sp), damage=active.settlementEvents.find(e=>e.kind==='storm_impact');
  assert.ok(damage.plot && damage.buildings.length===1);
  assert.equal(campClimate(active).storm,true);
  const impacted=plotWeather(active,beds(active));
  assert.deepEqual(impacted.filter(p=>p.windDamage).map(p=>p.id),[damage.plot.id]);
  assert.ok(geometry(active).some(b=>b.occluder==='plot:'+damage.plot.id && b.rot));
  const ctx={time:.51,focus:[0,0],bounds:{west:-14,east:14,north:-14,south:14},
    surface:(x)=>({y:x<0?2:0,water:x<0})};
  const fx=stormEffects({...ctx,active:campClimate(active).storm});
  assert.ok(fx.some(box=>box.y>2 && box.h===.009),'surface ripples above the water level');
  assert.ok(fx.some(box=>box.rot),'airborne leaves');
  assert.notDeepEqual(stormEffects({...ctx,active:true,time:.78}),fx);
  assert.deepEqual(stormEffects({...ctx,active:campClimate(forecast).storm}),[]);
  const damaged=[];
  addCampWork(damaged,active,[]);
  assert.notDeepEqual(damaged,intact);
  w.t+=DAY_TICKS;
  advanceSurvival(w);
  const after=survView(sp), afterBoxes=[];
  assert.deepEqual(stormEffects({...ctx,active:campClimate(after).storm}),[]);
  addCampWork(afterBoxes,after,[]);
  assert.deepEqual(afterBoxes,damaged,'damage persists after the weather clears');
  w.pinv.p1={wood:1,stone:1};
  assert.ok(doRepair(w,'p1','well').ok);
  const repaired=[];
  addCampWork(repaired,survView(sp),[]);
  assert.deepEqual(repaired,intact);
});

test('寒潮挂霜随实际寒潮清除，普通冬雪和预警不产生挂霜',()=>{
  const sp=createSurvPlay(13,options),w=sp.world,s=w.survival;
  s.disasters=true;w.ecologyExperiment={noStorm:true};w.weather='cold';w.t=3*DAY_TICKS;
  advanceSurvival(w);
  assert.deepEqual([campClimate({...survView(sp),season:'冬',coldsnapTomorrow:true}).frost,
    campClimate({...survView(sp),season:'冬'}).snow],[false,true]);
  w.t+=DAY_TICKS;advanceSurvival(w);
  assert.equal(campClimate(survView(sp)).frost,true);
  w.t+=DAY_TICKS;w.weather='clear';advanceSurvival(w);
  assert.equal(campClimate(survView(sp)).frost,false);
});

test('旱地裂纹与萎蔫随实际浇水减轻，旧档和雨后原有作物恢复直立',()=>{
  const sp=createSurvPlay(13,options), w=sp.world,s=w.survival;
  const plot=s.plots[0], other=s.plots[1];
  plot.growth=.8;other.growth=.8;s.water=.16;s.drought=true;
  const dry=survView(sp), [p1,p2]=plotWeather(dry,beds(dry));
  assert.equal(p1.dryness,p2.dryness);
  const boxesFor=(view,id)=>geometry(view).filter(b=>b.occluder==='plot:'+id);
  const cracks=(view,id)=>boxesFor(view,id).filter(b=>b.color==='#432B26').length;
  assert.ok(cracks(dry,plot.id)>0);
  assert.ok(boxesFor(dry,plot.id).some(b=>b.rot));
  assert.equal(plotWeather({...dry,drought:false},beds(dry))[0].dryness,0);
  w.pinv.p1.water=1;s.playerPos={x:plot.at[0],z:plot.at[1],t:w.t};
  assert.ok(survAct(sp,{kind:'camp_water',tool:'bucket',from:plot.at,plot:plot.id}).ok);
  const watered=survView(sp);
  assert.ok(cracks(watered,plot.id)<cracks(dry,plot.id));
  assert.deepEqual(boxesFor(watered,other.id),boxesFor(dry,other.id));
  const copy=loadSurv(structuredClone(dumpSurv(sp)),13,options);
  assert.deepEqual(plotWeather(survView(copy),beds(survView(copy))),plotWeather(watered,beds(watered)));
  w.t=3*DAY_TICKS;w.weather='rain';advanceSurvival(w);
  const rain=survView(sp);
  assert.equal(cracks(rain,plot.id),0);
  assert.ok(boxesFor(rain,plot.id).every(b=>!b.rot));
});

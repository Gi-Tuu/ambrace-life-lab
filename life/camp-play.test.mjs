import assert from 'node:assert/strict';
import test from 'node:test';
import { campSleepTicks } from './camp-play.mjs';
import { createSurvPlay, dumpSurv, loadSurv, survAct } from './survplay.mjs';

test('家具库存独立、进存档、放入与取回守恒',()=>{
  const sp=createSurvPlay(7), act=(kind,fields)=>survAct(sp,{kind,...fields});
  sp.world.pinv.p1.wood=3;
  assert.equal(act('camp_store',{target:'store:0',type:'wood'}).ok,false);
  act('move',{room:'store'});
  assert.equal(act('camp_store',{target:'store:0',type:'wood'}).ok,true);
  assert.equal(act('camp_take',{target:'store:1',type:'wood'}).ok,false);
  const restored=loadSurv(structuredClone(dumpSurv(sp)),7);
  assert.equal(restored.world.pinv.p1.wood,2);
  assert.equal(survAct(restored,{kind:'camp_take',target:'store:0',type:'wood'}).ok,true);
  assert.equal(restored.world.pinv.p1.wood,3);
  assert.equal(survAct(restored,{kind:'camp_store',target:'store:0',type:'__proto__'}).ok,false);
});

test('工具、来源和菜畦一一对应，餐桌吃饭实际扣食物',()=>{
  const sp=createSurvPlay(7), w=sp.world, act=(kind,fields)=>survAct(sp,{kind,...fields});
  w.survival.produce.egg=1;
  act('move',{room:'yard'});
  assert.equal(act('camp_collect',{type:'egg',tool:'bucket'}).ok,false);
  assert.equal(act('camp_collect',{type:'egg',tool:'basket'}).ok,true);
  assert.equal(w.survival.produce.egg,0);
  assert.equal(act('camp_collect',{type:'egg',tool:'basket'}).ok,false);
  act('move',{room:'home'});
  assert.equal(act('camp_store',{target:'home:meal',type:'egg'}).ok,true);
  assert.equal(act('camp_eat',{type:'egg'}).ok,true);
  assert.equal(act('camp_eat',{type:'egg'}).ok,false);
  assert.equal(w.survival.mealsEaten,1);
  assert.ok(campSleepTicks(w).ticks>0);
  act('move',{room:'garden'});
  w.survival.plots[0].growth=1; w.survival.plots[2].growth=1;
  assert.equal(act('camp_collect',{type:'crop',tool:'basket',plot:2}).ok,true);
  assert.equal(w.survival.plots[0].growth,1);
  assert.equal(w.survival.plots[2].growth,0);
  assert.equal(act('camp_plant',{tool:'hoe',plot:2}).ok,true);
  assert.equal(w.survival.plots[2].growth,.1);
  assert.equal(campSleepTicks(w).ok,false);
});

test('牛奶、羊毛、水和木托盘使用各自工具、产出和配方',()=>{
  const sp=createSurvPlay(7), w=sp.world, act=(kind,fields)=>survAct(sp,{kind,...fields});
  w.survival.produce.milk=1; w.survival.produce.wool=1; w.survival.produce.fruit=1;
  act('move',{room:'yard'});
  assert.equal(act('camp_collect',{type:'wool',tool:'shears'}).ok,true);
  assert.equal(act('camp_collect',{type:'milk',tool:'bucket'}).ok,true);
  assert.equal(act('camp_collect',{type:'fruit',tool:'basket'}).ok,false);
  act('move',{room:'garden'});
  assert.equal(act('camp_collect',{type:'fruit',tool:'basket'}).ok,true);
  assert.equal(act('camp_collect',{type:'water',tool:'bucket'}).ok,false);
  act('move',{room:'well'});
  for (let i=0;i<3;i++) assert.equal(act('camp_collect',{type:'water',tool:'bucket'}).ok,true);
  assert.equal(act('camp_collect',{type:'water',tool:'bucket'}).code,'BUCKET_FULL');
  act('move',{room:'garden'});
  w.survival.water=.5;
  assert.equal(act('camp_water',{tool:'bucket'}).ok,true);
  assert.equal(w.survival.water,.62);
  assert.equal(w.pinv.p1.water,2);
  act('move',{room:'workshop'});
  w.pinv.p1.wood=2;
  assert.equal(act('camp_craft',{type:'tray'}).ok,true);
  assert.equal(w.pinv.p1.wood,0);
  assert.equal(w.pinv.p1.tray,1);
});

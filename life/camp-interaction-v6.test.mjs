import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, playerTimeLeft } from './survplay.mjs';
import { openTalk, sayTo, talkInRange } from './dialogue.mjs';
import { move } from './body.mjs';
import { campBeds, campEntrance, campPen, campPlants, campSite } from '../web/camp-interaction.mjs';
import { TIMBER_GROVE } from '../web/camp-layout.mjs';

const make=()=>createSurvPlay(13,{independentWorld:true,wildFood:true,ecosystem:true});

test('实体对话验证室内和室外距离，居民跨逻辑地点移动仍可交谈',async()=>{
  const sp=make(),w=sp.world;
  w.agents.a1.drives.v.social=.3;
  const outside={target:'a1',room:null,from:[21.5,24.5],to:[22.5,24.5]};
  assert.notEqual(w.loc.p1,w.loc.a1);
  assert.equal(openTalk(sp,{...outside,from:[10,10],to:[10.2,10]}).code,'RESIDENT_OUT_OF_REACH');
  assert.equal(openTalk(sp,{...outside,from:[16,24]}).code,'RESIDENT_OUT_OF_REACH');
  move(w,'a1','hall');
  assert.ok(openTalk(sp,outside).ok);
  assert.ok(await sayTo(sp,{...outside,text:'你好'}));
  const chat=w.survival.talk;
  assert.ok(talkInRange(w,chat));
  move(w,'a1','store');
  assert.equal(talkInRange(w,chat),false);
  assert.equal((await sayTo(sp,{...outside,text:'还在吗'})).code,'NOT_TOGETHER');
  move(w,'a1','home');
  const door=campEntrance('home',campSite('home'));
  assert.ok(survAct(sp,{kind:'move',room:'home',entrance:true,from:[door.x+1,door.z+.8]}).ok);
  assert.equal(openTalk(sp,outside).code,'RESIDENT_OUT_OF_REACH');
  assert.ok(openTalk(sp,{target:'a1',room:'home',from:[6.9,9],to:[6,9]}).ok);
  assert.ok(survAct(sp,{kind:'camp_exit'}).ok);
  assert.equal(w.survival.talk,null);
});

test('采集请求以实体和距离决定来源，不提前移动玩家或重复扣工时',()=>{
  const sp=make(),w=sp.world,s=w.survival;
  const tree=TIMBER_GROVE[0], from=[tree.x+1,tree.z], base={kind:'camp_chop',target:tree.id,tool:'axe',from};
  assert.equal(survAct(sp,{...base,from:[0,0]}).code,'OUT_OF_REACH');
  assert.equal(survAct(sp,{...base,tool:'hand'}).code,'NEED_TOOL');
  assert.equal(playerTimeLeft(w),100);
  assert.ok(survAct(sp,base).ok);
  assert.equal(w.loc.p1,'hall');
  assert.equal(playerTimeLeft(w),25);
  assert.equal(survAct(sp,base).code,'ACTION_BUDGET');
  w.t++;
  assert.equal(survAct(sp,base).code,'TREE_GROWING');
  const plant=campPlants(null,3).find(p=>p.item==='berry'&&p.site==='yard');
  const berry={kind:'camp_collect',type:'berry',target:plant.id,tool:'basket',from:[plant.x,plant.z+1]};
  const prior=s.wildBerries.yard;
  assert.ok(survAct(sp,berry).ok);
  assert.equal(s.wildBerries.yard,prior-1);
  assert.equal(s.wildBerries.garden,4);
  w.t++;s.wildBerries.yard=0;
  assert.equal(survAct(sp,berry).code,'FORAGE_COOLDOWN');
  w.t++;
  assert.equal(survAct(sp,berry).code,'NO_WILD_FOOD');
  const fruit=campPlants(null,3)[0];
  assert.equal(survAct(sp,{kind:'camp_collect',type:'fruit',target:fruit.id,tool:'basket',from:[fruit.x,fruit.z+1]}).code,'NO_PRODUCE');
});

test('农田和动物请求校验对象、距离和真实库存，重复操作没有第二份产物',()=>{
  const sp=make(),w=sp.world,s=w.survival;
  const bed=campBeds(campSite('garden'))[0];
  const crop={kind:'camp_collect',type:'crop',plot:0,tool:'basket',from:[bed.x,bed.z]};
  s.plots[0].growth=.5;
  assert.equal(survAct(sp,crop).code,'NO_MATURE');
  assert.equal(survAct(sp,{...crop,plot:8}).code,'BAD_PLOT');
  s.plots[0].growth=1;
  assert.ok(survAct(sp,crop).ok);
  assert.equal(w.pinv.p1.crop,1);
  const pen=campPen(campSite('yard')), to=[pen.x+2,pen.z+3], from=[to[0]+1,to[1]];
  for(const [kind,item,tool] of [['chickens','egg','basket'],['cows','milk','bucket'],['sheep','wool','shears']]){
    w.t++;s.produce[item]=1;
    const collect={kind:'camp_collect',type:item,target:kind+':0',tool,from,to};
    assert.equal(survAct(sp,{...collect,target:kind+':42'}).code,'NO_ANIMAL');
    assert.equal(survAct(sp,{...collect,to:[0,0]}).code,'OUT_OF_REACH');
    assert.ok(survAct(sp,collect).ok);
    assert.equal(s.produce[item],0);
    w.t++;
    assert.equal(survAct(sp,collect).code,'NO_PRODUCE');
  }
});

test('建筑只允许从正式入口进入，失败保留行动时间',()=>{
  const sp=make(),w=sp.world,door=campEntrance('yard',campSite('yard'));
  const enter={kind:'move',room:'yard',entrance:true};
  assert.equal(survAct(sp,{...enter,from:[20,30]}).code,'OUT_OF_REACH');
  assert.equal(playerTimeLeft(w),100);
  assert.ok(survAct(sp,{...enter,from:[door.x+1,door.z+1]}).ok);
  assert.equal(w.campPlayerRoom,'yard');
  assert.ok(survAct(sp,{kind:'camp_exit'}).ok);
  assert.equal(w.campPlayerRoom,null);
});



test('点击工地的施工和维修由同一地块校验，玩家逻辑地点无需改写',()=>{
  const sp=make(),w=sp.world,s=w.survival;
  const lot={x:25,z:27,w:4,d:3.2};
  s.sites=[{loc:'yard',type:'granary',lot,progress:4}];
  const target='work:yard:granary', from=[25,30.5];
  assert.equal(survAct(sp,{kind:'build',target,from:[20,20]}).code,'OUT_OF_REACH');
  assert.equal(playerTimeLeft(w),100);
  assert.ok(survAct(sp,{kind:'build',target,from}).ok);
  assert.equal(w.loc.p1,'hall');
  assert.equal(s.buildings[0].integrity,1);
  w.t++;s.buildings[0].integrity=.45;
  w.pinv.p1={wood:1,stone:1};
  assert.ok(survAct(sp,{kind:'repair',target,from}).ok);
  assert.equal(s.buildings[0].integrity,1);
});

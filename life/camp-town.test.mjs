import assert from 'node:assert/strict';
import test from 'node:test';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView } from './survplay.mjs';
import { affordancesFor } from './body.mjs';
import { DAY_TICKS } from './clock.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { timberStage } from '../web/camp-3d-scene.mjs';
import { TOWN_SIZE, TIMBER_GROVE } from '../web/camp-layout.mjs';
import { readCollisionData, writeCollisionData } from '../web/collision.mjs';

test('伐木产生木料、树苗与树桩，拒绝重复砍伐并可跨档再生',()=>{
  const sp=createSurvPlay(), w=sp.world, tree=TIMBER_GROVE[0], action={kind:'camp_chop',tool:'axe',target:tree.id};
  assert.equal(survAct(sp,action).code,'NO_TREE');
  survAct(sp,{kind:'move',room:tree.site});
  assert.ok(survAct(sp,action).ok);
  assert.equal(survAct(sp,action).code,'TREE_GROWING');
  assert.equal(w.pinv.p1.wood,2);
  const restored=loadSurv(structuredClone(dumpSurv(sp)));
  const state=()=>survView(restored).camp.timber;
  const solid=()=>timberStage(state()).boxes.filter(b=>b.occluder===`timber:${tree.id}` && b.solid).length;
  assert.equal(state()[tree.id].stage,'sapling');
  assert.equal(solid(),0);
  restored.world.t+=3*DAY_TICKS;
  assert.equal(state()[tree.id].stage,'mature');
  assert.ok(solid()>0);
});

test('个人住房各自有入口和独立储物，旧档仍分配住所',()=>{
  const sp=createSurvPlay();
  const v=survView(sp), {p1,a1}=v.housing;
  assert.equal(new Set(Object.values(v.housing)).size,4);
  assert.ok(v.rooms[p1] && v.rooms[a1]);
  survAct(sp,{kind:'move',room:a1});
  assert.equal(campSleepTicks(sp.world).ok,false);
  survAct(sp,{kind:'move',room:p1});
  assert.ok(campSleepTicks(sp.world).ok);
  sp.world.pinv.p1.wood=1;
  assert.ok(survAct(sp,{kind:'camp_store',target:`${p1}:2`,type:'wood'}).ok);
  assert.ok(survAct(sp,{kind:'camp_take',target:`${p1}:2`,type:'wood'}).ok);
  const old=structuredClone(dumpSurv(sp));
  assert.deepEqual(survView(loadSurv(old)).housing,v.housing);
});

test('扩图保留旧碰撞坐标，包括跨旧地图行尾的像素',()=>{
  const oldWidth=96*16, width=TOWN_SIZE.width*16, height=TOWN_SIZE.depth*16;
  const grids={map:{width,height,legacy:[oldWidth,64*16]}};
  const old=JSON.stringify({version:3,scenes:{map:[[oldWidth-1,2,0]]}});
  const restored=readCollisionData(old,grids);
  assert.deepEqual([...restored.get('map')],[[oldWidth-1,0],[width,0]]);
  const current=writeCollisionData(restored,grids);
  assert.equal(JSON.parse(current).version,4);
  assert.deepEqual(readCollisionData(current,grids),restored);
});

test('试玩居民夜间能自主选择回自己的小屋，实验候选保持原样',()=>{
  const {world}=createSurvPlay(7,{residentialDecisions:true});
  const homes=new Set(Object.values(world.housing));
  const choices=w=>affordancesFor(w,'a1').filter(a=>a.kind==='move_to' && homes.has(a.to)).map(a=>a.to);
  assert.deepEqual(choices(world),[]);
  world.t=20;
  assert.deepEqual(choices(world),[world.housing.a1]);
  const control=createSurvPlay().world;
  control.t=20;
  assert.deepEqual(choices(control),[]);
});

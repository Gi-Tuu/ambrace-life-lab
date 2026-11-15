import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, playerTimeLeft, settleSurvival, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { actuate, move } from './body.mjs';
import { validate } from './rules.mjs';
import { changeHomeAccess, homeEntry } from './home-access.mjs';
import { discussionAction, discussionSupport, finishDiscussion } from './settlement-social.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS } from './clock.mjs';
import { doBuild, doPlan, effectiveMods } from './production.mjs';
import { finishCooperation } from './cooperation.mjs';
import { campEntrance, campSite } from '../web/camp-interaction.mjs';
import { facilityGate, facilityId } from '../web/camp-facility.mjs';

const options={residentialDecisions:true,eventRulesVersion:CURRENT_EVENT_RULES,settlementLife:true,
  independentWorld:true,ecosystem:true,wildFood:true,autonomousGoals:true,unifiedCooperation:true,farmLife:true};
const make=(seed=13,overrides={})=>createSurvPlay(seed,{...options,...overrides});
const restore=(sp,overrides={})=>loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))),13,{...options,...overrides});
const gatePoint=r=>[r.x+r.w*.5,r.z+r.d*.8];
const atDoor=(w,room)=>gatePoint(campEntrance(room,campSite(room,w.campLayout)));
const enter=(sp,room)=>survAct(sp,{kind:'move',room,entrance:true,from:atDoor(sp.world,room)});

test('住宅钥匙、常驻授权与时限邀请共用进门裁决；恢复、撤销与继承后重验',()=>{
  const sp=make(),w=sp.world,room=w.housing.a1,own=w.housing.p1;
  assert.equal(enter(sp,room).code,'HOME_LOCKED');
  assert.equal(validate(w,'a2',{kind:'move_to',to:room}).code,'HOME_LOCKED');
  assert.equal(actuate(w,'a2',{kind:'move_to',to:room}).code,'HOME_LOCKED');
  assert.ok(enter(sp,own).ok);
  assert.ok(survAct(sp,{kind:'camp_exit'}).ok);
  const grant=(type,kind='home_grant')=>changeHomeAccess(w,'a1',{room,target:'p1',type,kind});
  assert.ok(grant('key').ok);
  assert.ok(enter(sp,room).ok);
  assert.equal(survAct(sp,{kind:'camp_take',target:room+':2',type:'wood'}).code,'NO_CONTAINER');
  assert.equal(restore(sp).world.campPlayerRoom,room);
  assert.ok(grant('key','home_revoke').ok);
  settleSurvival(sp);
  assert.equal(w.campPlayerRoom,null);
  assert.equal(w.loc.p1,'hall');
  assert.ok(grant('invite').ok);
  assert.ok(enter(sp,room).ok);
  w.t+=DAY_TICKS;
  assert.equal(restore(sp).world.campPlayerRoom,undefined);
  settleSurvival(sp);
  assert.ok(grant('permission').ok);
  assert.ok(homeEntry(w,'p1',room).ok);
  assert.ok(changeHomeAccess(w,'a1',{room,target:'a2',type:'key',kind:'home_grant'}).ok);
  assert.ok(validate(w,'a2',{kind:'move_to',to:room}).ok);
  w.housing.a2=room;
  w.survival.households.spouses={a1:'a2',a2:'a1'};
  w.agents.a1.viab.v=0;
  settleSurvival(sp);
  assert.equal(w.survival.households.deeds[room].owner,'a2');
  assert.equal(homeEntry(w,'p1',room).code,'HOME_LOCKED');
  assert.ok(homeEntry(w,'a2',room).ok);
  assert.equal(survView(restore(sp)).social.marriages.history[0].ended,w.t);
});

test('近距离可请求住户邀请，破门要锤、工时并损害信任，维修恢复门锁',()=>{
  const sp=make(),w=sp.world,room=w.housing.a1;
  move(w,'a1','hall');
  const [x,z]=campSite('hall',w.campLayout);
  const request={kind:'home_request',home:room,target:'a1',room:null,from:[x,z],to:[x+.5,z+.5]};
  assert.equal(survAct(sp,request).code,'INVITE_DECLINED');
  w.agents.a1.relations.meet('p1',w.t,{delta:{trust:35}});
  assert.ok(survAct(sp,request).ok);
  w.t+=DAY_TICKS;
  const act={kind:'home_break',room,from:atDoor(w,room)};
  assert.equal(survAct(sp,{...act,tool:'hand'}).code,'NEED_TOOL');
  assert.equal(survAct(sp,{...act,tool:'hammer',from:[0,0]}).code,'OUT_OF_REACH');
  assert.equal(playerTimeLeft(w),100);
  assert.ok(survAct(sp,{...act,tool:'hammer'}).ok);
  assert.equal(playerTimeLeft(w),25);
  assert.equal(w.agents.a1.relations.map.get('p1').trust,50);
  assert.ok(enter(sp,room).ok);
  const view=survView(restore(sp));
  assert.equal(view.homeAccess[room].damage,.5);
  assert.equal(view.social.changes.at(-1).why,'破门');
  w.housing.p1=room;
  w.pinv.p1.wood=1;
  survAct(sp,{kind:'camp_exit'});
  w.t++;
  assert.ok(survAct(sp,{...act,kind:'home_fix',tool:'hammer'}).ok);
  w.housing.p1='house1';
  assert.equal(homeEntry(w,'p1',room).code,'HOME_LOCKED');
});

test('真实居民决策发起、谢绝、离开及产生分歧，关闭后无讨论记录',async()=>{
  const sp=make(), off=make(13,{discussions:false});
  for (const world of [sp,off]) for (let i=0;i<144;i++) await tickSurvPlay(world);
  const history=survView(sp).social.discussions.history;
  assert.ok(history.some(m=>m.result==='split' && new Set(Object.values(m.advice)).size>1));
  assert.ok(history.some(m=>Object.values(m.members).includes('declined')));
  assert.equal(off.world.survival.discussions.history,undefined);
  assert.deepEqual(survView(restore(sp,{discussions:false})).social.discussions.history,history);
  assert.equal(sp.world.survival.agentErrors??0,0);
  assert.deepEqual(survView(restore(sp)).social.discussions.history,history);
});

test('有共识时建议进入实际行动比较，没有工地或缺料仍由原规则驳回',()=>{
  const sp=make(),w=sp.world,s=w.survival;
  s.store=0;
  for (const a of Object.values(w.agents)) if (!a.isPlayer) {
    a.drives.v.energy=.9;
    for (const id of ['a1','a2','a3']) if (id!==a.id) a.relations.meet(id,w.t,{delta:{trust:60}});
  }
  assert.ok(discussionAction(w,'a2','discuss_open',true).ok);
  assert.ok(discussionAction(w,'a1','discuss_join',true).ok);
  assert.ok(discussionAction(w,'a3','discuss_join',true).ok);
  w.agents.a3.drives.v.energy=.3;
  assert.ok(discussionAction(w,'a3','discuss_leave',true).ok);
  finishDiscussion(w,sp.log);
  assert.equal(s.discussions.history.at(-1).result,'agreed');
  assert.ok(w.agents.a1.memory.rows.some(row=>row.kind==='discussion_result'));
  assert.equal(discussionSupport(w,'a1',{kind:'harvest'}),.18);
  assert.equal(discussionSupport(w,'a3',{kind:'harvest'}),0);
  assert.equal(validate(w,'a1',{kind:'harvest'}).code,'NOT_GARDEN');
  assert.ok(!discussionAction(w,'a1','discuss_open').ok);
});

test('功能建筑经施工完工后才可使用，仓粮守恒、工坊加工、避难休息和墙体防护',()=>{
  const sp=make(),w=sp.world,s=w.survival;
  s.inv.wood=s.inv.stone=100;
  for (const [loc,type] of [['yard','granary'],['watch','shelter'],['garden','workshop'],['well','wall']]) {
    move(w,'a1',loc);
    assert.ok(doPlan(w,'a1',type).ok);
    assert.ok(!survAct(sp,{kind:'move',room:'facility:'+loc+':'+type,entrance:true,from:[0,0]}).ok);
    s.coop.task={loc,type,workers:['a1','a2']};
    for (let i=0;s.sites.some(p=>p.loc===loc);i++) assert.ok(doBuild(w,i%2?'a2':'a1',loc).ok);
    finishCooperation(w);
  }
  const get=type=>s.buildings.find(b=>b.type===type);
  for (const type of ['granary','shelter','workshop']) {
    const b=get(type),target=facilityId(b), from=gatePoint(facilityGate(b,w.campLayout));
    w.t++;
    assert.equal(survAct(sp,{kind:'facility_use',target}).code,'OUT_OF_REACH');
    assert.equal(survAct(sp,{kind:'move',room:target,entrance:true,from:[0,0]}).code,'OUT_OF_REACH');
    assert.ok(survAct(sp,{kind:'move',room:target,entrance:true,from}).ok);
    assert.equal(restore(sp).world.campPlayerRoom,target);
    if (type==='granary') {
      const before=s.store;
      assert.ok(survAct(sp,{kind:'facility_use',target,type:'withdraw'}).ok);
      assert.equal(w.pinv.p1.crop,1);
      assert.equal(s.store,before-1);
      w.t++;
      assert.ok(survAct(sp,{kind:'facility_use',target,type:'deposit'}).ok);
      assert.equal(s.store,before);
    } else if (type==='workshop') {
      w.pinv.p1.wood=2;
      assert.equal(survAct(sp,{kind:'facility_use',target,tool:'hand'}).code,'NEED_TOOL');
      assert.ok(survAct(sp,{kind:'facility_use',target,tool:'hammer'}).ok);
      assert.equal(w.pinv.p1.tray,1);
    } else {
      w.agents.p1.drives.v.energy=.4;
      assert.ok(survAct(sp,{kind:'facility_use',target}).ok);
      assert.ok(w.agents.p1.drives.v.energy>.4);
    }
    b.integrity=0;
    settleSurvival(sp);
    assert.equal(w.campPlayerRoom,null);
  }
  const wall=get('wall'),target=facilityId(wall);
  w.t++;
  assert.equal(survAct(sp,{kind:'move',room:target,entrance:true}).code,'NO_FACILITY');
  assert.ok(survAct(sp,{kind:'facility_use',target,from:gatePoint(facilityGate(wall,w.campLayout))}).shield);
  wall.integrity=0;
  assert.equal(effectiveMods(w).shield,false);
  const records=survView(restore(sp)).social.cooperation;
  assert.equal(records.length,4);
  assert.deepEqual(records[0].participants,['a1','a2']);
});

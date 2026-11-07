import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHorizonPlanner} from './m3-planner.mjs';
import {Organism} from './agent.mjs';
import {makeWorld,spawn,affordancesFor,LOCS} from './body.mjs';
import {validate} from './rules.mjs';
const S=(v={})=>({selfId:'a1',loc:'hall',energy:.7,social:.1,pantry:3,energySetpoint:.55,socialSetpoint:.55,companions:{a2:.2},...v});
const rest={id:'rest',kind:'rest',cost:.02};
const talk={id:'talk:a2',kind:'talk',target:'a2',cost:.1};
test('同屋已知熟悉度的对话预测与真实执行一致，包括两次增长的封顶',()=>{
 for(const familiarity of [0,.2,.9,.96,1]){
  const w=makeWorld({pantries:3,stash:3}),a=new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:7});
  w.agents.a1=a;w.agents.a2={id:'a2',name:'绛'};spawn(w,'a1','hall');spawn(w,'a2','hall');w.t=5;a.world=w;
  a.drives.v.social=.1;a.relations.get('a2').familiarity=familiarity;
  const action=affordancesFor(w,'a1').find(x=>x.id==='talk:a2');assert.ok(action);assert.equal(validate(w,'a1',action).ok,true);
  const s=S({energy:a.drives.v.energy,social:a.drives.v.social,energySetpoint:a.drives.setpoint.energy,socialSetpoint:a.drives.setpoint.social,companions:{a2:familiarity}});
  const plan=new ShortHorizonPlanner({commitment:1}).step({snapshot:s,actions:[action],catalog:[]});
  const predicted=plan.plans.find(x=>x.first.id==='talk:a2').predicted.afterFirst;
  assert.equal(a.execute(w,action,'deliberation',w.t,true).ok,true);
  assert.ok(Math.abs(predicted.social-a.drives.v.social)<1e-12,`familiarity ${familiarity}`);
  assert.ok(Math.abs(predicted.companions.a2-a.relations.get('a2').familiarity)<1e-12);
 }
});
test('同一个公开快照只改变 social，能改变动作相对比较；无可用谈话为负控',()=>{
 const run=(social,actions,catalog)=>new ShortHorizonPlanner({commitment:1}).step({snapshot:S({social}),actions,catalog});
 const low=run(.1,[rest,talk],[rest,talk]),high=run(.8,[rest,talk],[rest,talk]);
 assert.equal(low.action.id,'talk:a2');assert.equal(high.action.id,'rest');
 const score=(r,id)=>r.plans.filter(p=>p.first.id===id).reduce((a,b)=>a.score>b.score?a:b).score;
 assert.ok(score(low,'talk:a2')-score(low,'rest')>score(high,'talk:a2')-score(high,'rest'));
 const cutLow=run(.1,[rest],[rest]),cutHigh=run(.8,[rest],[rest]);assert.equal(cutLow.plans[0].score,cutHigh.plans[0].score);
});
test('第二步公开位置与真实 validate 一致，未知 moon 和自身 talk 被拒绝',()=>{
 const w=makeWorld({pantries:3,stash:3});w.agents.a1={id:'a1',name:'岑'};w.agents.a2={id:'a2',name:'绛'};spawn(w,'a1','hall');spawn(w,'a2','hall');
 const destinations=['home','store','watch','moon'];const moves=destinations.map(to=>({id:'move_to:'+to,kind:'move_to',to,cost:.06}));
 const self={id:'talk:a1',kind:'talk',target:'a1',cost:.1};
 const r=new ShortHorizonPlanner({commitment:1}).step({snapshot:S({companions:{a1:.5,a2:.2}}),actions:[rest],catalog:[...moves,self]});
 const second=new Set(r.plans.map(p=>p.second?.id));
 for(const a of moves){assert.equal(second.has(a.id),validate(w,'a1',a).ok,`${a.to}, known: ${Object.hasOwn(LOCS,a.to)}`)}
 assert.equal(validate(w,'a1',self).ok,false);assert.equal(second.has(self.id),false);
});
test('移动后不推测目的地同伴，拒绝未知类型与缺失成本',()=>{
 const go={id:'move_to:home',kind:'move_to',to:'home',cost:.06};
 const r=new ShortHorizonPlanner({commitment:1}).step({snapshot:S(),actions:[go],catalog:[talk]});
 assert.ok(r.plans.every(p=>p.second===null),'移动后无法知悉同伴是否仍在场');
 assert.throws(()=>new ShortHorizonPlanner().step({snapshot:S(),actions:[{id:'x',kind:'unknown',cost:0}],catalog:[]}),/未知/);
 assert.throws(()=>new ShortHorizonPlanner().step({snapshot:S(),actions:[{id:'rest',kind:'rest'}],catalog:[]}),/未知/);
});

test('同屋不移动的假设下，休息后对话的预测与真实执行一致，且不修改快照',()=>{
 const w=makeWorld({pantries:3,stash:3}),a=new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:7});
 w.agents.a1=a;w.agents.a2={id:'a2',name:'绛'};spawn(w,'a1','hall');spawn(w,'a2','hall');w.t=5;a.world=w;
 a.drives.v.social=.1;a.relations.get('a2').familiarity=0;
 const action=affordancesFor(w,'a1').find(x=>x.id==='talk:a2');
 const snapshot=S({energy:a.drives.v.energy,social:.1,energySetpoint:a.drives.setpoint.energy,socialSetpoint:a.drives.setpoint.social,companions:{a2:0}}),before=JSON.stringify(snapshot);
 const r=new ShortHorizonPlanner({commitment:1}).step({snapshot,actions:[rest],catalog:[action]});
 const path=r.plans.find(x=>x.first.id==='rest'&&x.second?.id==='talk:a2');assert.ok(path);
 assert.equal(JSON.stringify(snapshot),before);assert.equal(a.relations.get('a2').familiarity,0);
 a.execute(w,rest,'deliberation',w.t,true);w.t++;assert.equal(validate(w,'a1',action).ok,true);a.execute(w,action,'deliberation',w.t,true);
 assert.ok(Math.abs(path.predicted.afterSecond.social-a.drives.v.social)<1e-12);
 assert.ok(Math.abs(path.predicted.afterSecond.companions.a2-a.relations.get('a2').familiarity)<1e-12);
});

test('对话改变关系后，禁止沿用旧模板预测第二次对话的成本',()=>{
 const r=new ShortHorizonPlanner({commitment:1}).step({snapshot:S(),actions:[talk],catalog:[talk,rest]});
 assert.ok(r.plans.every(p=>p.second?.kind!=='talk'));
});

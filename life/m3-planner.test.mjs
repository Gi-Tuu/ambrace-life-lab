import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHorizonPlanner} from './m3-planner.mjs';
const rest={id:'rest',kind:'rest',cost:.02};
const go={id:'move_to:home',kind:'move_to',to:'home',cost:.06};
const eat={id:'eat',kind:'eat',cost:.05};
const catalog=[rest,go,eat];
const state=(v={})=>({selfId:'a1',loc:'hall',energy:.1,social:.5,pantry:1,energySetpoint:.55,socialSetpoint:.42,...v});
test('两步预测可选择先移动再进食，不执行或修改传入快照与候选',()=>{
 const snapshot=state(), actions=[rest,go], b=JSON.stringify({snapshot,actions,catalog}),planner=new ShortHorizonPlanner();
 const r=planner.step({snapshot,actions,catalog});
 assert.equal(r.action.id,'move_to:home');assert.equal(r.goal,'recover');assert.equal(r.plans[0].second.id,'eat');
 assert.equal(JSON.stringify({snapshot,actions,catalog}),b);
 const p=r.plans[0];assert.equal(p.cost1,.06);assert.equal(p.cost2,.05);
 assert.ok(Math.abs(p.score-(p.gain1-.1*p.cost1+.8*(p.gain2-.1*p.cost2)))<1e-12);
});
test('同一完整历史和输入确定性一致，无历史与承诺历史产生不同决策',()=>{
 const a=new ShortHorizonPlanner({commitment:3}),b=new ShortHorizonPlanner({commitment:3});
 const x={snapshot:state(),actions:[rest,go],catalog};assert.deepEqual(a.step(x),b.step(x));
 const atHome=state({loc:'home'}), available=[rest,eat];
 const committed=a.step({snapshot:atHome,actions:available,catalog});
 assert.equal(committed.action.id,'eat');assert.equal(committed.reused,true);assert.equal(committed.goal,'recover');assert.equal(committed.action.cost,.05);
 const loaded=new ShortHorizonPlanner({commitment:3});loaded.load(b.dump());
 assert.deepEqual(b.step({snapshot:atHome,actions:available,catalog}),loaded.step({snapshot:atHome,actions:available,catalog}));
 const different=new ShortHorizonPlanner({commitment:3});
 different.step({snapshot:state({loc:'home',pantry:0}),actions:[rest],catalog:[rest]});
 assert.notEqual(different.step({snapshot:atHome,actions:available,catalog}).action.id,committed.action.id);
});
test('承诺到期重选；动作不可用或目标变化时中断并记录',()=>{
 const p=new ShortHorizonPlanner({commitment:3});p.step({snapshot:state(),actions:[rest,go],catalog});
 const r=p.step({snapshot:state({loc:'home',pantry:0}),actions:[rest],catalog});
 assert.equal(r.interrupted,'committed_goal_unavailable');assert.equal(r.action.id,'rest');
 const empty=p.step({snapshot:state({loc:'home',pantry:0}),actions:[],catalog});assert.equal(empty.action,null);assert.equal(empty.remaining,0);
});
test('承诺长度按可用机会计数，反射不更新任何内部状态',()=>{
 const p=new ShortHorizonPlanner({commitment:3});p.step({snapshot:state({loc:'home'}),actions:[rest,eat],catalog});
 const before=p.dump();const r=p.step({reflex:true});assert.equal(r.reflex,true);assert.deepEqual(p.dump(),before);
 const x={snapshot:state({loc:'home'}),actions:[rest,eat],catalog};const b=p.step(x),c=p.step(x),d=p.step(x);
 assert.equal(b.reused,true);assert.equal(c.reused,true);assert.equal(c.remaining,0);assert.equal(d.reused,false);
});
test('不凭空使用未来私人信息：不生成未来交谈或私人取食模板',()=>{
 const p=new ShortHorizonPlanner({commitment:1});const talk={id:'talk:x',kind:'talk',target:'x',cost:.1}, theft={id:'take_shared:x',kind:'take_shared',target:'x',cost:.2};
 const r=p.step({snapshot:state(),actions:[rest,go],catalog:[rest,go,eat,talk,theft]});
 assert.ok(r.plans.every(x=>!x.second||!['talk','take_shared'].includes(x.second.kind)));
});
test('饱和与缺粮被显式约束；旧存档空初始化，非法数据不得静默通过',()=>{
 const p=new ShortHorizonPlanner();p.load(undefined);assert.deepEqual(p.dump(),{state:null,remaining:0});
 const r=p.step({snapshot:state({loc:'home',energy:1,pantry:0}),actions:[rest,eat],catalog});
 assert.equal(r.action.id,'rest');assert.ok(r.plans.every(x=>x.gain1===0));
 assert.throws(()=>p.load({state:{goal:'fake',action:rest},remaining:1}));
 assert.throws(()=>p.step({snapshot:state({energy:NaN}),actions:[rest],catalog}));
});


test('look_out 已建模为"移动到瞭台"，且不会伪造留在居所再进食的二步路径', async()=>{
 const {makeWorld,spawn,actuate}=await import('./body.mjs');
 const w=makeWorld({pantries:2,stash:3});w.agents.a1={id:'a1',name:'甲'};spawn(w,'a1','home');
 const observe={id:'look_out',kind:'look_out',cost:.18};
 actuate(w,'a1',observe);assert.equal(w.loc.a1,'watch','反例必须真正改变世界位置');
 const p=new ShortHorizonPlanner({commitment:1});
 const r=p.step({snapshot:state({loc:'home'}),actions:[rest,eat,observe],catalog});
 const cases=r.plans.filter(x=>x.first.id==='look_out');assert.ok(cases.length>0);
 // 收益模型补齐后，首步位置必须与真实 actuate 的移动一致；
 // 原断言（second===null 且 predictionComplete=false）已随"look_out 被建模"过时，真正要守的是"不许排在居所吃饭"
 assert.ok(cases.every(x=>x.predictionComplete&&x.predicted.afterFirst.loc==='watch'),'首步位置没有对齐真实 actuate 的移动');
 assert.ok(cases.every(x=>!x.second||x.second.kind!=='eat'),'排出了"已在瞭台却仍回居所吃饭"的二步路径');
});

test('同一承诺目标随合法动作改变而重新竞争，返回当前完整对象',()=>{
 const p=new ShortHorizonPlanner({commitment:3});
 const first=p.step({snapshot:state(),actions:[rest,go],catalog});assert.equal(first.goal,'recover');assert.equal(first.action.id,'move_to:home');
 const changedEat={...eat,cost:.07,serves:{energy:1},label:'真实本轮动作'};
 const second=p.step({snapshot:state({loc:'home'}),actions:[rest,changedEat],catalog:[rest,changedEat]});
 assert.equal(second.goal,'recover');assert.equal(second.reused,true);assert.deepEqual(second.action,changedEat);assert.notEqual(second.action,changedEat);
});

test('没有同屋证据时，计划不能伪造社交变化',()=>{
 const p=new ShortHorizonPlanner({commitment:1});const r=p.step({snapshot:state(),actions:[rest,go],catalog});
 assert.ok(r.plans.every(x=>x.predicted.afterFirst===null||x.predicted.afterFirst.social===.5));
 assert.ok(r.plans.every(x=>x.predicted.afterSecond===null||x.predicted.afterSecond.social===.5));
 assert.ok(r.plans.every(x=>x.goal!=='connect'));
});

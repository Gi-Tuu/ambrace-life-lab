import test from 'node:test';
import assert from 'node:assert/strict';
import { ShortHorizonPlanner } from './m3-planner.mjs';
import { Organism } from './agent.mjs';
import { makeWorld,spawn,affordancesFor,actuate } from './body.mjs';
for(const kind of ['rest','eat','move_to']) test(`候选预测的 ${kind} 状态变化对齐真实确定性路径`,()=>{
 const w=makeWorld({pantries:3,stash:3});const a=new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:7});w.agents.a1=a;spawn(w,'a1','home');a.drives.v.energy=.4;a.drives.v.social=.2;
 const action=affordancesFor(w,'a1').find(x=>x.kind===kind);assert.ok(action);
 const snapshot={selfId:a.id,companions:{},loc:w.loc.a1,energy:a.drives.v.energy,social:a.drives.v.social,pantry:w.pantry,energySetpoint:a.drives.setpoint.energy,socialSetpoint:a.drives.setpoint.social};
 const result=new ShortHorizonPlanner().step({snapshot,actions:[action],catalog:[]});const predicted=result.plans[0].predicted.afterFirst;
 assert.equal(w.loc.a1,'home');assert.equal(w.pantry,3);assert.equal(a.drives.v.energy,.4);
 const actual=actuate(w,'a1',action);assert.ok(actual.ok);if(actual.satiated)a.drives.reward(actual.satiated,actual.amount??.1);
 assert.equal(predicted.loc,w.loc.a1);assert.equal(predicted.pantry,w.pantry);assert.equal(predicted.energy,a.drives.v.energy);assert.equal(predicted.social,a.drives.v.social);
});

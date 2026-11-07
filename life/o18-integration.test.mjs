import test from 'node:test';
import assert from 'node:assert/strict';
import { Organism } from './agent.mjs';
import { makeWorld, spawn, affordancesFor } from './body.mjs';
import { scoreAll, channelsFor } from './model.mjs';

function setup(){const w=makeWorld({pantries:6,stash:3});const a=new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:7});w.agents.a1=a;w.agents.a2={id:'a2',name:'绛'};spawn(w,'a1','hall');spawn(w,'a2','home');a.drives.v.energy=.1;return {w,a};}
function scores(w,a,portion,on){w.riskyPortion=portion;const actions=affordancesFor(w,a.id);return scoreAll(actions,{drives:a.drives,traits:a.traits,bank:a.bank,ch:channelsFor('C2',{expectedYield:on}),memBonus:{},risk:0});}
test('固定状态预期份量改变越轨比较，切断后两组逐位相同，其他行动不受影响',()=>{const {w,a}=setup();const low=scores(w,a,.45,1),high=scores(w,a,1.1,1),cutLow=scores(w,a,.45,0),cutHigh=scores(w,a,1.1,0);const by=(xs,id)=>xs.find(x=>x.id===id);const id='take_shared:a2';assert.ok(by(high,id).u>by(low,id).u);assert.ok(by(high,id).parts.预期份量>0);assert.equal(by(cutLow,id).u,by(cutHigh,id).u);assert.equal(by(cutLow,id).u,by(low,id).u);for(const x of low.filter(x=>x.id!==id))assert.equal(x.u,by(high,x.id).u);});
test('需求饱和时收益额外份量不改变比较',()=>{const {w,a}=setup();a.drives.v.energy=.95;const lo=scores(w,a,.45,1),hi=scores(w,a,1.1,1);assert.equal(lo.find(x=>x.id==='take_shared:a2').u,hi.find(x=>x.id==='take_shared:a2').u);});
test('行动记录保存 tick 入口快照且不受后续状态变化污染',async()=>{const {w,a}=setup();w.t=1;const before={...a.drives.v};const loc=w.loc.a1;await a.tick(w);const row=a.trace.find(x=>x.action);assert.ok(row);assert.deepEqual(row.tickStart.drives,before);assert.equal(row.tickStart.loc,loc);a.drives.v.energy=0;w.loc.a1='home';assert.equal(row.tickStart.drives.energy,before.energy);assert.equal(row.tickStart.loc,loc);});

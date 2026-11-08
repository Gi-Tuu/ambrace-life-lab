import test from 'node:test';
import assert from 'node:assert/strict';
import {Organism} from './agent.mjs';
import {appraise} from './appraisal.mjs';
import {eventExposure,EventExposureLedger} from './m5-event-exposure.mjs';
const a=new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:17});
const ctx={traits:a.traits,drives:a.drives,memory:a.memory,relations:a.relations,t:0,m:a.bank.m};
const ev=(kind,valence,violates=null)=>({kind,valence,violates,selfCaused:true,about:null});
const assess=e=>appraise(e,ctx);
const contact=ev('contact',.4),negative=ev('shortfall',-.4),breach=ev('normbreak',.45,'order'),sameNoBreach=ev('normbreak',.45);
function checkSemantics(score){
 assert.equal(score(contact,assess(contact)),0,'正价普通事件误记暴露');
 assert.equal(score(sameNoBreach,assess(sameNoBreach)),0,'同价无违规误记暴露');
 assert.ok(score(negative,assess(negative))>0,'负价事件遗漏');
 assert.ok(score(breach,assess(breach))>0,'正价但违反规范的事件遗漏');
}
test('真实 appraisal 的负价与规范冲突分别计入，不将正价等同压力',()=>{
 checkSemantics(eventExposure);
 assert.equal(eventExposure(negative,assess(negative)),.4);
 assert.equal(eventExposure(breach,assess(breach)),assess(breach).parts.norm);
 const both=ev('witnessed',-.4,'order'),result=eventExposure(both,assess(both));
 assert.equal(result,Math.max(.4,assess(both).parts.norm));
});
test('逐事件累积防止同刻正负抵消，消费一次并有上限',()=>{
 const ledger=new EventExposureLedger({enabled:true});
 ledger.observe(contact,assess(contact));ledger.observe(negative,assess(negative));
 assert.equal(ledger.consume(),.4);assert.equal(ledger.consume(),0);
 ledger.observe(negative,assess(negative));ledger.observe(breach,assess(breach));
 assert.equal(ledger.consume(),1);assert.equal(ledger.dump().count,3);
});
test('默认关闭时不产生或写入暴露，非法数值不得静默变零',()=>{
 const ledger=new EventExposureLedger(),before=ledger.dump();
 assert.equal(ledger.observe(negative,assess(negative)),0);assert.equal(ledger.consume(),0);assert.deepEqual(ledger.dump(),before);
 assert.throws(()=>eventExposure({...negative,valence:NaN},assess(negative)));
 assert.throws(()=>new EventExposureLedger({enabled:true,score:()=>NaN}).observe(negative,assess(negative)));
});
test('零暴露与只认负价两个变异都让真实事件语义闸门变红',()=>{
 assert.throws(()=>checkSemantics(()=>0),/负价事件遗漏/);
 assert.throws(()=>checkSemantics(e=>Math.max(0,-e.valence)),/正价但违反规范/);
});

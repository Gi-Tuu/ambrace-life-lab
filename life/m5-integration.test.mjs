import test from 'node:test';
import assert from 'node:assert/strict';
import {Organism} from './agent.mjs';
import {ModulatorBank} from './modulators.mjs';
import {M5ModulatorBank} from './m5-bank.mjs';
import {appraise} from './appraisal.mjs';
import {scoreAll,channelsFor} from './model.mjs';
import {makeWorld,spawn} from './body.mjs';
import {PARAMS,paramsFingerprint,assertFrozen} from './params.mjs';
import {makeRng} from './rng.mjs';
import {sampleTraits} from './traits.mjs';
const evt=(kind,valence,violates=null)=>({kind,valence,violates,selfCaused:true,about:null});
const make=(mask=null,condition='C2')=>new Organism({id:'a1',name:'岑',archetype:'谨慎',seed:17,condition,channelMask:mask});
const context=(a,e,t=0)=>({traits:a.traits,drives:a.drives,memory:a.memory,relations:a.relations,t,m:a.bank.m});
const act=[{id:'low',kind:'rest',impulse:.1,serves:{},cost:0},{id:'high',kind:'look_out',impulse:.9,serves:{},cost:0}];
function gap(a,util=1){const x=scoreAll(act,{drives:a.drives,traits:a.traits,bank:a.bank,ch:channelsFor('C2',{util}),memBonus:{},risk:0});return x.find(z=>z.id==='high').u-x.find(z=>z.id==='low').u;}
function drive(a,t){
 if(t===1||t===20){const e=evt('shortfall',-.25);a.bank.inject({arousal:.12});a.bank.observeEvent(e,appraise(e,context(a,e,t)));}
 a.bank.tick();
}
test('默认严格走原调制器，C2-neg 不会被显式 M5 掩码接通',()=>{
 const a=make(),b=make({m5:0}),n=make({m5:1},'C2-neg'),on=make({m5:1});
 assert.ok(a.bank instanceof ModulatorBank);assert.ok(b.bank instanceof ModulatorBank);assert.ok(n.bank instanceof ModulatorBank);
 assert.equal(n.ch.m5,0);assert.ok(on.bank instanceof M5ModulatorBank);assert.equal(typeof a.bank.observeEvent,'undefined');
});
test('真实 assess 将负价与正价违规逐事件入账，正价正常事件为零且消费一次',()=>{
 const a=make({m5:1}),w=makeWorld({pantries:6,stash:3});w.agents.a1=a;spawn(w,'a1','home');a.world=w;
 a.assess(evt('contact',.4));assert.equal(a.bank.exposure.pending,0);
 a.assess(evt('shortfall',-.4));a.assess(evt('contact',.4));assert.equal(a.bank.exposure.pending,.4);
 a.assess(evt('normbreak',.45,'order'));assert.equal(a.bank.exposure.pending,1);
 a.bank.tick();assert.equal(a.bank.exposure.pending,0);assert.equal(a.bank.slow,PARAMS.m5.slowScale);assert.equal(a.bank.load,1);
 const first=a.bank.load;a.bank.tick();assert.ok(a.bank.load<first);assert.equal(a.bank.exposure.pending,0);
 const cut=make({m5:1,m5Exposure:0});cut.world=w;cut.assess(evt('shortfall',-.4));assert.equal(cut.bank.exposure.pending,0);cut.bank.tick();assert.equal(cut.bank.slow,0);
});
test('慢读数、负荷、反馈和延迟分别改变真实行动相对评分，切效用后差别归零',()=>{
 const arms={full:make({m5:1}),read:make({m5:1,m5Read:0}),load:make({m5:1,m5Load:0}),feedback:make({m5:1,m5Feedback:0}),delay:make({m5:1,m5Delay:0})};
 const seen=Object.fromEntries(Object.keys(arms).filter(k=>k!=='full').map(k=>[k,0]));
 for(let t=1;t<=60;t++){
  for(const a of Object.values(arms))drive(a,t);
  for(const [k,a] of Object.entries(arms))if(k!=='full'){
   seen[k]=Math.max(seen[k],Math.abs(gap(arms.full)-gap(a)));
   assert.ok(Math.abs(gap(arms.full,0)-gap(a,0))<1e-12,`切效用后 ${k} 仍改相对分差`);
  }
 }
 for(const [k,value] of Object.entries(seen))assert.ok(value>1e-10,`${k} 未进入真实行动相对分差：${value}`);
});
test('四维快自抑作用于真实更新，单切读数不切慢输入与负荷',()=>{
 const on=make({m5:1}),off=make({m5:1,m5Brake:0});on.bank.fast.m.arousal=off.bank.fast.m.arousal=.9;
 on.bank.tick();off.bank.tick();assert.ok(on.bank.fast.m.arousal<off.bank.fast.m.arousal);
 const read=make({m5:1,m5Read:0});drive(read,1);assert.ok(read.bank.slow>0&&read.bank.load>0);assert.equal(read.bank.m.arousal,read.bank.fast.m.arousal);
});
test('待消费事件与队列可恢复并在固定随机输入下续演；旧档安全初始化',()=>{
 const traits=sampleTraits(makeRng(12),'谨慎'),a=new M5ModulatorBank(traits,()=>.5),b=new M5ModulatorBank(traits,()=>.5);
 const e=evt('shortfall',-.4),fake={parts:{norm:0}};
 a.observeEvent(e,fake);a.inject({arousal:.07});for(let i=0;i<12;i++)a.tick();
 a.observeEvent(e,fake);a.inject({arousal:.06});const state=a.dumpM5();
 assert.ok(state.exposure.pending>0&&state.pending.arousal>0&&state.queue.length>0);
 assert.equal(b.loadM5(state), 'loaded');assert.deepEqual(b.dumpM5(),state);assert.deepEqual(b.snapshot(),a.snapshot());
 for(let i=0;i<40;i++){a.tick();b.tick();assert.deepEqual(b.dumpM5(),a.dumpM5());assert.deepEqual(b.snapshot(),a.snapshot());}
 const old=new M5ModulatorBank(traits,()=>.5);assert.equal(old.loadM5(undefined,{...traits.baseline,arousal:.3}),'legacy');assert.equal(old.m.arousal,.3);assert.equal(old.slow,0);assert.equal(old.load,0);
 const invalid={...state,delay:99};assert.throws(()=>old.loadM5(invalid),/无效或不兼容/);
});
test('外部 arousal 钳制作用于统一读数，必要时如实削减慢分量',()=>{
 const a=make({m5:1});a.bank.slow=.4;a.bank.m.arousal=.1;
 assert.equal(a.bank.m.arousal,.1);assert.equal(a.bank.slow,.1);assert.equal(a.bank.fast.m.arousal,0);
});
test('反射机会不推进慢时钟，待事件只在真实非反射更新消费',async()=>{
 const a=make({m5:1}),w=makeWorld({pantries:6,stash:3});w.agents.a1=a;spawn(w,'a1','home');w.t=1;
 a.bank.slow=.3;a.bank.load=.4;a.bank.queue=[.2];w.percepts=[{for:'all',kind:'alarm',subject:'墙外',salience:.9}];
 await a.tick(w);assert.equal(a.counters.reflex,1);assert.equal(a.bank.slow,.3);assert.equal(a.bank.load,.4);assert.deepEqual(a.bank.queue,[.2]);
});
test('慢仓量纲进入冻结指纹，同组更改会被抓到',()=>{
 const original=PARAMS.m5.feedback,label='M5冻结测试';
 try{assertFrozen(label,paramsFingerprint());PARAMS.m5.feedback=original*2;assert.throws(()=>assertFrozen(label,paramsFingerprint()),/参数漂移/);}
 finally{PARAMS.m5.feedback=original;assertFrozen.seen.delete(label);}
});

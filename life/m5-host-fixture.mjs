// 子进程夹具：不同启动变量和同一临时存档；不连接真实模型或公开实例。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const mode=process.argv[2],dir=process.env.DATA_DIR;
const {host}=await import('./host.mjs');
if(mode==='bad'||mode==='badseed'){
 const path=mode==='badseed'?process.env.SEED_FILE:join(dir,'world.json');
 const before=await readFile(path);
 await assert.rejects(host.start(),/M5_STATE_INVALID/);
 assert.match(host.status().saveError,/M5_STATE_INVALID/);
 assert.equal(host.status().t,0,'损坏档案不能部分载入世界');
 host.stop();assert.deepEqual(await readFile(path),before,'坏档被覆盖');
 if(mode==='badseed')await assert.rejects(readFile(join(dir,'world.json')),{code:'ENOENT'});
 console.log(JSON.stringify({mode,error:host.status().saveError}));
}else{
await host.start();host.stop();
const p=host.packs.A,a=p.agents.a1,b=host.packs.B.agents.a1;
assert.equal(Boolean(b.ch.m5),false,'C2-neg 不得启用 M5');
assert.deepEqual(host.status().masks,{m3:false,coupling:false});
const read=async()=>JSON.parse(await readFile(join(dir,'world.json'),'utf8'));
if(mode==='first'){
 assert.equal(a.ch.m5,1);a.world=p.world;
 a.assess({kind:'shortfall',valence:-.4,violates:null,selfCaused:false,about:null});
 for(let i=0;i<9;i++)await host.tickOnce();
 const oldTick=a.tick.bind(a);
 a.tick=async w=>{const r=await oldTick(w);if(w.t===10)a.assess({kind:'shortfall',valence:-.4,violates:null,selfCaused:false,about:null});return r;};
 await host.tickOnce();
 const raw=await read(),saved=raw.A.agents.a1.m5;
 assert.ok(saved);assert.deepEqual(saved,a.bank.dumpM5());assert.ok(saved.slow>0);assert.ok(saved.exposure.pending>0);
 console.log(JSON.stringify({mode,saved,bM5:Boolean(b.ch.m5),masks:host.status().masks}));
}else if(mode==='off'){
 assert.ok(!a.ch.m5);const prior=(await read()).A.agents.a1.m5;assert.ok(prior);
 assert.deepEqual(a.bank.snapshot(),prior.fast,'关闭载档应回快仓而非把慢分量双算');
 for(let i=0;i<10;i++)await host.tickOnce();
 const saved=(await read()).A.agents.a1.m5;assert.ok(saved,'关闭时抹掉慢状态');
 for(const k of ['slow','load','queue','exposure','pending','delay'])assert.deepEqual(saved[k],prior[k],`休眠慢字段 ${k} 被改写`);
 assert.deepEqual(saved.fast,a.bank.snapshot(),'休眠状态未跟上关闭档真实快仓');
 console.log(JSON.stringify({mode,prior,saved,bM5:Boolean(b.ch.m5),masks:host.status().masks}));
}else if(mode==='resume'){
 assert.equal(a.ch.m5,1);const saved=(await read()).A.agents.a1.m5;
 assert.deepEqual(a.bank.dumpM5(),saved,'启用重启没有恢复完整慢状态');
 const before=a.bank.dumpM5(),actions=a.counters.actions;let expected=before.load;
 for(let i=0;i<3;i++)expected=Math.max(0,Math.min(1,expected-expected/160+(i===0?before.exposure.pending:0)));
 await host.ctl({action:'catchup',minutes:3});
 const after=a.bank.dumpM5();assert.equal(after.load,expected,'休眠期间待暴露未恰好消费一次');
 assert.equal(after.exposure.pending,0);assert.equal(after.exposure.count,before.exposure.count);assert.ok(Object.values(after.pending).every(v=>v===0));assert.equal(a.counters.actions,actions,'休眠虚构行动');
 console.log(JSON.stringify({mode,before,after,bM5:Boolean(b.ch.m5),masks:host.status().masks}));
}else if(mode==='legacy'){
 assert.equal(a.ch.m5,1);assert.equal(a.bank.slow,0);assert.equal(a.bank.load,0);assert.deepEqual(a.bank.queue,[]);
 console.log(JSON.stringify({mode,slow:a.bank.slow,load:a.bank.load,bM5:Boolean(b.ch.m5)}));
}else throw new Error(`未知模式 ${mode}`);
}

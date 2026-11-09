// 子进程夹具：不同启动变量和同一临时存档；不连接真实模型或公开实例。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const mode=process.argv[2],dir=process.env.DATA_DIR;
const {host}=await import('./host.mjs');
if(mode==='bad'||mode==='badseed'){
 const path=mode==='badseed'?process.env.SEED_FILE:join(dir,'world.json');
 const before=await readFile(path);
 // H-05 之后 start() 不再因为 M5 状态不符而 rethrow（旧行为会让 serve 顶层 await 崩、容器无限重启、
 // 而 world.json 原封不动 ⇒ 不可自愈）。新契约：**禁用 M5 降级装载、历史保留**，降级原因进 saveError。
 // 判据仍是"坏档没被静默接受"：saveError 必须点名 M5_STATE_INVALID，且档案文件不得被改名/覆盖。
 await host.start();
 assert.match(String(host.status().saveError),/M5_STATE_INVALID/,'降级没有点名 M5_STATE_INVALID');
 assert.ok(host.status().t>0,'降级装载没有保留历史（t 归零 = 把历史丢了）');
 host.stop();assert.deepEqual(await readFile(path),before,'坏档被覆盖');
 if(mode==='badseed')await assert.rejects(readFile(join(dir,'world.json')),{code:'ENOENT'});
 console.log(JSON.stringify({mode,error:host.status().saveError,t:host.status().t}));
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

// 回归真实宿主的名字档生命周期。故障注入仅触碰独占的临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { move } from './body.mjs';

const dir=mkdtempSync(join(tmpdir(),'camp-persistence-'));
Object.assign(process.env,{DATA_DIR:dir,SEED_FILE:join(dir,'missing'),GAME_MODE:'game',TICK_MS:'1000000',ACT_SAVE_COALESCE_MS:'0'});
const {host,openCamp,campSurv}=await import('./host.mjs');
const {loadCamp,readIndex,touchSave,SAVE_TTL_MS}=await import('./camp-instances.mjs');

test('A01 淘汰前落盘同一营地，后续保存及重启不会把它替换为主档', async t => {
  await host.start();
  t.after(()=>host.stop());
  const camps=[];
  for (let i=0;i<7;i++) {
    const opened=await openCamp('测试营地'+i);
    assert.equal(opened.ok,true);
    camps.push(opened);
  }
  const latest=camps.at(-1).key;
  assert.ok((await host.act({mode:'survival',kind:'move',room:'garden'},latest)).persisted);
  const expected=campSurv(latest).world.t+1;
  await host.ctl({action:'step'});
  for (const {key} of camps.slice(0,-1)) await host.readWorld('menu',key);
  assert.equal(await host.save(),true);
  assert.equal(loadCamp(dir,latest).loc.p1,'garden');
  assert.equal(loadCamp(dir,latest).t,expected);
  assert.equal(host.snapshot().survival.loc.p1,'hall');
  host.stop();
  await host.start();
  assert.equal((await host.readWorld('menu',latest)).survival.loc.p1,'garden');
});

test('A02 名字档写入失败不会返回已持久化，也不会被主档成功掩盖', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('故障营地');
  mkdirSync(join(dir,'saves',key+'.json.gz.tmp'));
  const result=await host.act({mode:'survival',kind:'move',room:'yard'},key);
  assert.equal(result.ok,true);
  assert.equal(result.persisted,false);
  assert.equal(loadCamp(dir,key).loc.p1,'hall');
  assert.ok(host.snapshot('survival',key).saveError);
  assert.equal(await host.save(),false);
  assert.ok(host.status().saveError);
});

test('A03/A04 重开与 A/B 快照按选中的名字档路由，主营地字节保持', async t=>{
  await host.start();
  t.after(()=>host.stop());
  assert.equal(await host.save(),true);
  const main=readFileSync(join(dir,'world.json'),'utf8');
  const {key}=await openCamp('另起对照');
  assert.ok((await host.act({mode:'survival',kind:'move',room:'yard'},key)).ok);
  const copied=await host.ctl({mode:'compare',action:'compare_reset',confirm:true,fromSurvival:true},key);
  assert.ok(copied.ok);
  const {A,B}=host.snapshot('compare',key).comparison;
  assert.equal(A.loc.p1,'yard');
  assert.equal(B.loc.p1,'yard');
  const seed=host.snapshot('menu',key).survival.mapSeed;
  const restarted=await host.ctl({action:'survival_reset',confirm:true},key);
  assert.ok(restarted.ok);
  assert.notEqual(loadCamp(dir,key).mapSeed,seed);
  assert.equal(loadCamp(dir,key).loc.p1,'hall');
  assert.equal(readFileSync(join(dir,'world.json'),'utf8'),main);
});

test('A06 生存推进异常在本拍可见，下一次完整推进后恢复', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('推进故障');
  const w=campSurv(key).world;
  const percepts=w.percepts;
  Object.defineProperty(w,'percepts',{configurable:true,get:()=>percepts,set:()=>{throw Error('TEST_TICK_FAILED');}});
  try {
    await host.ctl({action:'step'});
    assert.match(host.status().tickError,/TEST_TICK_FAILED/);
  } finally {
    Object.defineProperty(w,'percepts',{configurable:true,writable:true,value:percepts});
  }
  await host.ctl({action:'step'});
  assert.equal(host.status().tickError,null);
});

test('复审：刚访问的旧档在暂停及重启后仍受三天保留期保护', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('暂停时访问');
  const now=Date.now();
  touchSave(dir,{key,lastSeenAt:now-SAVE_TTL_MS+60_000});
  host.stop();
  await host.start();
  await host.ctl({action:'pause'});
  await host.readWorld('survival',key);
  host.stop();
  await host.start();
  assert.ok(!host.sweepCamps({now:now+600_000}).removed.includes(key));
  assert.equal((await host.readWorld('menu',key)).camp.key,key);
  assert.ok(host.sweepCamps({now:now+SAVE_TTL_MS+600_000}).removed.includes(key));
});

test('复审：已有冷档换入失败时返回不可用，保留双方文件', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const camps=[];
  for (let i=0;i<7;i++) camps.push(await openCamp('冷档回归'+i));
  const [cold,oldest]=camps;
  const coldFile=join(dir,'saves',cold.key+'.json.gz');
  const before=readFileSync(coldFile);
  mkdirSync(join(dir,'saves',oldest.key+'.json.gz.tmp'));
  await assert.rejects(host.readWorld('survival',cold.key),{code:'CAMP_UNAVAILABLE'});
  assert.deepEqual(readFileSync(coldFile),before);
  assert.equal((await host.readWorld('survival',oldest.key)).camp.key,oldest.key);
});

test('复审：重开写入失败保留旧索引和世界进度', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('重开回滚');
  const world=campSurv(key).world;
  world.t=24;
  assert.ok(await host.save());
  const metadata=()=>readIndex(dir).entries.find(e=>e.key===key);
  const before=metadata();
  assert.equal(before.day,1);
  mkdirSync(join(dir,'saves',key+'.json.gz.tmp'));
  assert.equal((await host.ctl({action:'survival_reset',confirm:true},key)).error,'SAVE_FAILED');
  assert.deepEqual(metadata(),before);
  assert.equal(loadCamp(dir,key).t,24);
  assert.equal(campSurv(key).world,world);
});

test('复审：已常驻营地的读取等待整拍完成，并返回独立快照', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('整拍快照');
  const w=campSurv(key).world, agent=w.agents.a1, original=agent.tick;
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  agent.tick=async (...args)=>{enter();await wait;return original.apply(agent,args);};
  const before=w.t;
  const step=host.ctl({action:'step'});
  let resolved=false, request;
  try {
    await entered;
    request=host.readWorld('survival',key).then(view=>{resolved=true;return view;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(resolved,false);
  } finally { release();await step;agent.tick=original; }
  const view=await request;
  assert.equal(view.survival.t,before+1);
  await host.act({mode:'survival',kind:'move',room:'yard'},key);
  assert.equal(view.survival.loc.p1,'hall');
});

test('复审：名字营地休眠只推进当前营地', async t=>{
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('独立休眠');
  const main=host.snapshot().survival.t;
  const before=loadCamp(dir,key).t;
  const result=await host.ctl({action:'catchup',minutes:17},key);
  assert.ok(result.ok && result.persisted);
  assert.equal(result.catchup.applied,1);
  assert.equal(loadCamp(dir,key).t,before+1);
  assert.equal(host.snapshot().survival.t,main);
});
test('真模型对话只认本营地的访客，模型空位仍归各自供应商', async t => {
  const calls=[];
  const server=createServer(async (req,res) => {
    let body='';
    for await (const chunk of req) body+=chunk;
    calls.push([req.url,JSON.parse(body).model]);
    if (req.url.startsWith('/primary/')) { res.writeHead(503).end(); return; }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:'欢迎来到营地。'}}],usage:{total_tokens:3}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  host.setBackend({providers:[base+'/primary',base+'/secondary'],keys:['local-key'],
    model:'default-model',models:['','backup-model'],brain:'model'});
  await host.start();
  t.after(()=>host.stop());
  const {key}=await openCamp('对话分路');
  for (const camp of ['MAIN',key]) {
    const w=campSurv(camp).world;
    move(w,'a1',w.loc.p1);
    w.agents.a1.drives.v.social=.5;
    w.agents.a1.drives.v.energy=.9;
    assert.ok((await host.act({mode:'survival',kind:'talk_open',target:'a1'},camp)).ok);
  }
  const command={mode:'survival',kind:'talk_say',target:'a1',text:'你好'};
  await host.readWorld('survival',key);
  assert.equal((await host.readWorld('menu','MAIN')).survival.model.watching,false);
  assert.ok((await host.act(command,'MAIN')).ok);
  assert.equal(calls.length,0);
  assert.equal((await host.act(command,key)).line,'欢迎来到营地。');
  assert.deepEqual(calls,[['/primary/chat/completions','default-model'],['/secondary/chat/completions','backup-model']]);
  calls.length=0;
  host.setBackend({keys:['','local-backup-key']});
  assert.equal((await host.act(command,key)).line,'欢迎来到营地。');
  assert.deepEqual(calls,[['/secondary/chat/completions','backup-model']]);
});

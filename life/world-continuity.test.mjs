import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_TICKS } from './clock.mjs';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';

const options = { residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true };

test('T21/T22 玩家死亡后继续三十天，聚落衰亡独立结算并可读档', async () => {
  const p=createSurvPlay(7,options), w=p.world;
  w.agents.p1.viab.v=0;
  await tickSurvPlay(p);
  const start=survView(p);
  assert.equal(start.player.result,'dead');
  assert.equal(start.settlement,'active');
  assert.equal(survAct(p,{kind:'move',room:'yard'}).code,'PLAYER_DEAD');
  const saved=loadSurv(structuredClone(dumpSurv(p)),7,options);
  assert.equal(survView(saved).player.result,'dead');
  assert.equal(survView(saved).settlement,'active');
  const first=saved.world.agents.a1.counters.actions;
  for (let i=0;i<30*DAY_TICKS;i+=1) await tickSurvPlay(saved);
  const after=survView(saved);
  assert.equal(after.t,start.t+30*DAY_TICKS);
  assert.equal(after.player.result,'dead');
  assert.notDeepEqual(after.eco,start.eco);
  assert.ok(saved.world.agents.a1.counters.actions>first);
  assert.equal(saved.world.survival.lastDay,30);
  assert.ok(saved.world.survival.history.length>=30);
  const extinct=createSurvPlay(7,options);
  for (const a of Object.values(extinct.world.agents)) if (!a.isPlayer) a.viab.v=0;
  await tickSurvPlay(extinct);
  assert.equal(survView(extinct).settlement,'extinct');
  assert.equal(survView(extinct).player.result,'alive');
  assert.ok(survAct(extinct,{kind:'move',room:'yard'}).ok);
});

test('T25 模型等待期间排队采集、奠基、施工、睡眠和保存', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ambrace-queue-'));
  process.env.DATA_DIR=dir;
  process.env.SEED_FILE=join(dir,'none.json');
  process.env.TICK_MS='3600000';
  const {host}=await import('./host.mjs');
  const originalFetch=globalThis.fetch;
  let release, pending=false;
  globalThis.fetch=async (_url,{body})=>{
    const message=JSON.parse(body).messages[0].content;
    const id=/^- ([^ ]+) \| /m.exec(message)?.[1];
    if (message.includes('生存营地') && !pending) {
      pending=true;
      await new Promise(resolve=>{release=resolve;});
    }
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({id,reason:'测试'})}}]}));
  };
  try {
    host.setBackend({brain:'model',providers:['http://127.0.0.1:1'],keys:['fixture'],models:['fixture']});
    await host.start();
    const act=(kind,params={})=>host.act({mode:'survival',kind,...params});
    await act('move',{room:'watch'}); await act('gather'); await act('move',{room:'yard'});
    host.touch('survival');
    let running;
    for (let i=0;i<36 && !pending;i+=1) {
      running=host.tickOnce();
      await Promise.race([running,new Promise(resolve=>setTimeout(resolve,10))]);
    }
    assert.ok(pending);
    const before=host.snapshot().survival;
    const requests=[act('gather'),act('gather'),act('plan',{type:'shelter'}),act('build'),
      act('move',{room:'home'}),act('camp_sleep'),host.save()];
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(host.snapshot().survival.pinv.p1,before.pinv.p1);
    release();
    await running;
    const results=await Promise.all(requests);
    // P0-A：同一刻已有一次重劳动（gather），后续重劳动必须被行动预算拒绝；移动/睡眠仍可用。
    assert.equal(results[0].ok,true,JSON.stringify(results));
    assert.equal(results[1].code,'ACTION_BUDGET',JSON.stringify(results));
    assert.equal(results[2].code,'ACTION_BUDGET',JSON.stringify(results));
    assert.equal(results[3].code,'ACTION_BUDGET',JSON.stringify(results));
    assert.equal(results[4].ok,true,JSON.stringify(results));
    assert.equal(results[5].ok,true,JSON.stringify(results));
    const after=host.snapshot().survival;
    const disk=JSON.parse(await readFile(join(dir,'world.json'),'utf8'));
    assert.equal(disk.survival.t,after.t);
    assert.equal(after.t,before.t+results[5].ticks);
    assert.deepEqual(disk.survival.pinv,after.pinv);
    assert.ok(disk.survival.log.find(x=>x.kind==='gather'&&x.ok));
  } finally {
    release?.();
    globalThis.fetch=originalFetch;
    host.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

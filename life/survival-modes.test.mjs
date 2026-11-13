import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { actuate, affordancesFor, spawn } from './body.mjs';
import { DAY_TICKS } from './clock.mjs';
import { ADULT_DAYS, stepHouseholds, stepRelationships } from './households.mjs';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { generateCampLayout, constructionLot, overlapsLot } from '../web/camp-layout.mjs';
import { doPlan } from './production.mjs';
import { campTerrain } from '../web/camp-terrain.mjs';
import { outdoorStage, addCampWork } from '../web/camp-3d-scene.mjs';

const options = { residentialDecisions: true };

test('家庭须双方同意，原住房保留产权，出生和长大能够跨档', async () => {
  const sp = createSurvPlay(7, options), w = sp.world;
  w.survival.endFreeze = false;
  const h = w.survival.households, a = w.agents.a1, b = w.agents.a2;
  const room = w.housing.a2, old = w.housing.a1;
  const friend = (actor, other) => Object.assign(actor.relations.get(other), { trust: 65, familiarity: .8 });
  friend(a, b.id);
  stepRelationships(w, sp.log);
  assert.deepEqual(h.spouses, {});
  friend(b, a.id);
  stepRelationships(w, sp.log);
  assert.equal(h.spouses.a1, 'a2');
  assert.equal(h.spouses.a2, 'a1');
  assert.equal(w.housing.a1, old);
  w.t += DAY_TICKS;
  stepRelationships(w, sp.log);
  assert.equal(w.housing.a1, room);
  assert.deepEqual(h.deeds[old], { owner: 'a1', listed: true });
  w.survival.buildings.push({type:'shelter',loc:'yard',integrity:1});
  w.survival.store = 26;
  w.t = DAY_TICKS * 2 - 1;
  await tickSurvPlay(sp);
  const first = survView(sp);
  assert.equal(first.agents.c1.stage, 'infant'); // P1-1： newborn 是婴幼儿（0–3 天），3 天后转 child
  assert.deepEqual(first.households.residents.c1.parents, ['a1','a2']);
  assert.equal(first.housing.c1, room);
  const restored = loadSurv(structuredClone(dumpSurv(sp)), 99, options);
  assert.equal(restored.world.seed, 7);
  assert.equal(restored.world.occupancy[restored.world.loc.c1].includes('c1'),true);
  assert.equal(survView(restored).agents.c1.stage,'infant'); // P1-1：读档后 newborn 仍婴幼儿
  const rw = restored.world;
  rw.agents.c1.traits.archetype = '谨慎';
  rw.t = h.residents.c1.born + ADULT_DAYS * DAY_TICKS - 1;
  stepHouseholds(rw, restored.log);
  assert.equal(rw.survival.households.residents.c1.decision, undefined);
  rw.t += 1;
  rw.agents.a1.relations.get('c1').trust = 35;
  rw.agents.a2.relations.get('c1').trust = 35;
  stepHouseholds(rw, restored.log);
  assert.equal(survView(restored).agents.c1.stage,'adult');
  assert.equal(rw.survival.households.residents.c1.decision,'stayed');
  assert.equal(rw.housing.c1,room);
});

test('空房交易守恒，第二个买家改建，三次劳动后才登记入住', () => {
  const p = createSurvPlay(7, options), w = p.world, h=w.survival.households;
  h.deeds.house5.owner = 'p1';
  for (const id of ['a1','a2','a3']) h.residents[id] = { born: 0, parents: [] };
  w.t = ADULT_DAYS * DAY_TICKS;
  w.pinv.a1 = { wood: 2, stone: 2 };
  stepHouseholds(w,p.log);
  assert.equal(h.deeds.house5.owner,'p1');
  assert.equal(h.residents.a1.decision,'seeking');
  assert.deepEqual(w.pinv.a1,{wood:2,stone:2});
  w.pinv.a1.wood = 3;
  w.pinv.a2 = { wood: 5, stone: 3 };
  w.pinv.a3 = { wood: 5, stone: 3 };
  stepHouseholds(w,p.log);
  assert.equal(w.housing.a1,'house5');
  assert.deepEqual(w.pinv.p1,{wood:3,stone:2});
  assert.deepEqual(Object.keys(h.projects),['house6','house7']);
  assert.equal(w.housing.a2,'house3');
  assert.equal(w.locs.house6,undefined);
  assert.equal(addCampWork([],survView(p)).find(r=>r.record.loc==='house6').phase,'foundation');
  assert.equal(actuate(w,'a2',{kind:'house_work'}).ok,false);
  spawn(w,'a2','workshop');
  for (let i=0;i<3;i+=1) {
    assert.ok(affordancesFor(w,'a2').some(a=>a.kind==='house_work'));
    assert.ok(actuate(w,'a2',{kind:'house_work'}).ok);
    assert.equal(actuate(w,'a2',{kind:'house_work'}).ok,false);
    if (i<2) assert.equal(addCampWork([],survView(p)).find(r=>r.record.loc==='house6').phase,'frame');
    w.t+=DAY_TICKS;
    stepHouseholds(w,p.log);
  }
  assert.equal(w.housing.a2,'house6');
  assert.equal(h.deeds.house6.owner,'a2');
  assert.equal(h.residents.a2.decision,'built');
  assert.equal(h.projects.house6,undefined);
  const restored=loadSurv(structuredClone(dumpSurv(p)),7,options);
  assert.deepEqual(restored.world.housing,w.housing);
  assert.equal(restored.world.survival.households.deeds.house6.owner,'a2');
});

test('玩家可拒绝求婚，未会面时不能登记，同住需要空床', () => {
  const p=createSurvPlay(7,options), w=p.world, h=w.survival.households;
  const take=(kind, target, accept)=>survAct(p,{kind,target,accept});
  assert.equal(take('family_marry','a1').code,'MEET_REQUIRED');
  assert.ok(survAct(p,{kind:'move',room:'home'}).ok);
  w.sex.p1='F';
  Object.assign(w.agents.a1.relations.get('p1'),{trust:70,familiarity:1});
  stepRelationships(w,p.log);
  assert.ok(h.offers.some(o=>o.to==='p1'&&o.from==='a1'));
  assert.ok(take('family_answer','a1',false).ok);
  assert.equal(h.spouses.p1,undefined);
  assert.ok(take('family_marry','a1').ok);
  const room=w.housing.a1;
  w.agents.c1={id:'c1',name:'芽',viab:{v:1}}; // P0-1：床位按存活居民计；用真实第4人凑满床（旧 test 占位无角色，已被存活过滤正确排除）
  w.housing.a2=w.housing.a3=w.housing.c1=room;
  assert.equal(take('family_move','a1').code,'NO_BED');
  assert.equal(w.housing.p1,'house1');
  delete w.housing.c1;
  assert.ok(take('family_move','a1').ok);
  assert.equal(w.housing.p1,room);
});

test('随机河岸和丘陵可复现，同一坡面决定三维脚底高度', () => {
  const a=campTerrain(271), b=campTerrain(398);
  assert.deepEqual(a.hills,campTerrain(271).hills);
  assert.notDeepEqual(a.hills,b.hills);
  assert.equal(a.river(34),b.river(34));
  assert.notEqual(a.river(6),b.river(6));
  const scene=outdoorStage({tw:120,th:80,sites:{},trees:[],grass:[],hills:a.hills},[],[]);
  const [hill]=a.hills;
  assert.ok(scene.heightAt(hill.x,hill.z)>1);
  assert.ok(scene.heightAt(hill.x+1.3,hill.z+.75)>0);
  assert.equal(scene.heightAt(45,43),0);
});

test('整张新地图按种子生成，设施与施工位置共用服务端布局', () => {
  const seed=271, expected=generateCampLayout(seed);
  const other=generateCampLayout(398);
  assert.deepEqual(generateCampLayout(seed),expected);
  for (const [site,at] of Object.entries(expected.sites)) assert.notDeepEqual(at,other.sites[site],site);
  assert.notDeepEqual(expected.grove,other.grove);
  const terrain=campTerrain(seed,false,1);
  assert.notEqual(terrain.river(34),campTerrain(398,false,1).river(34));
  for (let i=1;i<=120;i+=1) {
    const map=generateCampLayout(i*59743);
    const lots=Object.values(map.lots);
    assert.ok(lots.every((a,j)=>lots.slice(j+1).every(b=>!overlapsLot(a,b,.35))));
  }
  const p=createSurvPlay(seed,{...options,mapSeed:seed,layoutVersion:1}), w=p.world;
  assert.ok(survAct(p,{kind:'move',room:'yard'}).ok);
  w.pinv.p1={wood:20,stone:20};
  assert.ok(doPlan(w,'p1','shelter').ok);
  const [work]=w.survival.sites;
  assert.deepEqual(work.at,expected.sites.yard);
  assert.deepEqual(work.lot,expected.lots.yard);
  assert.notDeepEqual(work.lot,constructionLot('yard'));
  const saved=structuredClone(dumpSurv(p));
  const loaded=loadSurv(saved,7,options);
  assert.deepEqual(survView(loaded).layout,expected);
  assert.deepEqual(loaded.world.survival.sites[0].lot,work.lot);
  delete saved.layoutVersion;
  assert.equal(survView(loadSurv(saved,7,options)).layout,undefined);
});

test('靠近角色才可空手交谈，重工具损伤存续与信任且随档保存', () => {
  const p=createSurvPlay(7,options), w=p.world, npc=w.agents.a1;
  const reach={kind:'camp_resident',target:'a1',room:null,from:[21.4,24.5],to:[22.5,24.5]};
  const use=(tool,extra={})=>survAct(p,{...reach,tool,...extra});
  assert.equal(use('axe',{from:[12,14]}).code,'RESIDENT_OUT_OF_REACH');
  assert.equal(use('axe',{room:'home'}).code,'RESIDENT_OUT_OF_REACH');
  assert.equal(use('axe',{from:[-1.1,10],to:[-1,10]}).code,'RESIDENT_OUT_OF_REACH');
  assert.equal(use('basket').code,'RESIDENT_NEED_HAND');
  assert.equal(npc.viab.v,1);
  assert.equal(use('hand').code,'RESIDENT_TALKED');
  assert.ok(use('hand',{from:[10.1,10],to:[10,10]}).line, '行走中的居民也可交谈');
  assert.equal(npc.relations.get('p1').trust,34);
  assert.equal(use('hammer').code,'RESIDENT_HURT');
  assert.equal(npc.viab.v,.86);
  assert.equal(npc.relations.get('p1').trust,19);
  assert.equal(use('axe').code,'RESIDENT_COOLDOWN');
  assert.ok(survAct(p,{kind:'move',room:'home'}).ok);
  assert.equal(use('hand',{room:'home',from:[8,9],to:[8.9,9]}).code,'RESIDENT_TALKED');
  const restored=loadSurv(structuredClone(dumpSurv(p)),7,options);
  assert.equal(restored.world.agents.a1.viab.v,.86);
  assert.equal(restored.world.survival.campWounds.a1.t,0);
});

test('宿主生存审议有独立在场闸门，重开保留对照且新地图跨档', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ambrace-survival-modes-'));
  process.env.DATA_DIR=dir;
  process.env.SEED_FILE=join(dir,'none.json');
  process.env.TICK_MS='3600000';
  process.env.MAX_CALLS='20';
  process.env.MAX_CALLS_PER_TICK='1';
  const {host}=await import('./host.mjs');
  const prompts=[];
  let valid=true;
  const upstream=createServer(async (req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const payload=JSON.parse(Buffer.concat(chunks));
    const prompt=payload.messages[0].content;
    prompts.push(prompt);
    const id=valid ? /^- ([^ ]+) \| /m.exec(prompt)?.[1] : 'not-a-legal-action';
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({id,reason:'测试'})}}],usage:{total_tokens:10}}));
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  try {
    host.setBackend({brain:'model',providers:[`http://127.0.0.1:${upstream.address().port}`],keys:['fixture'],models:['fixture']});
    await host.start();
    for (let i=0;i<6;i+=1) await host.tickOnce();
    assert.equal(prompts.length,0);
    host.touch('survival');
    for (let i=0;i<24 && !host.snapshot().survival.model.choices;i+=1) await host.tickOnce();
    const choices=host.snapshot().survival.model.choices;
    assert.ok(choices>0);
    assert.ok(prompts.every(prompt=>prompt.includes('生存营地') && !prompt.includes('undefined')));
    valid=false;
    const count=prompts.length;
    for (let i=0;i<24 && prompts.length===count;i+=1) await host.tickOnce();
    assert.ok(prompts.length>count);
    assert.equal(host.snapshot().survival.model.choices,choices);
    await host.ctl({action:'brain',brain:'local'});
    const disabled=prompts.length;
    for (let i=0;i<4;i+=1) await host.tickOnce();
    assert.equal(prompts.length,disabled);
    assert.equal(host.snapshot().survival.model.enabled,false);
    const before=host.snapshot();
    assert.equal((await host.ctl({action:'survival_reset'})).ok,false);
    const first=await host.ctl({action:'survival_reset',confirm:true});
    const second=await host.ctl({action:'survival_reset',confirm:true});
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.mapSeed,second.mapSeed);
    assert.equal(host.snapshot().survival.layoutVersion,1);
    assert.equal(host.snapshot().A.t,before.A.t);
    assert.equal(host.snapshot().B.t,before.B.t);
    assert.equal(host.snapshot().survival.t,0);
    await host.ctl({action:'compare_reset',confirm:true});
    const raw=JSON.parse(await readFile(join(dir,'world.json'),'utf8'));
    assert.equal(raw.survival.mapSeed,second.mapSeed);
    assert.equal(host.snapshot().survival.mapSeed,second.mapSeed);
    host.stop();
    await host.start();
    assert.equal(host.snapshot().survival.mapSeed,second.mapSeed);
  } finally {
    host.stop();
    upstream.closeAllConnections();
    await new Promise(resolve=>upstream.close(resolve));
    await rm(dir,{recursive:true,force:true});
  }
});

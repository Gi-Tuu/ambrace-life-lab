import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { move } from './body.mjs';
import { doForage, regrowWildBerries, WILD_BERRIES } from './production.mjs';

test('T24 居民自主选择住所及备粮目标，从正常开局执行并完成', async () => {
  const p = createSurvPlay(13, { unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true });
  const w=p.world;
  w.survival.coop.enabled=false;
  for (let i=0;i<240;i+=1) await tickSurvPlay(p);
  const logs=Object.values(w.survival.actionAudit);
  assert.ok(logs.some(r=>r.goals?.shelter?.gather && r.goals.shelter.plan && r.goals.shelter.build));
  assert.ok(w.survival.buildings.some(b=>b.type==='shelter'));
  assert.ok(logs.some(r=>r.goals?.food?.forage && r.goals.food.exchange));
  assert.equal(p.log.filter(x=>x.kind==='agentError').length,0);
});

test('T26/T27 玩家和 AI 共享野莓存量，采空后可恢复，旱寒压低恢复', () => {
  const options={wildFood:true}, p=createSurvPlay(7,options), w=p.world, s=w.survival;
  for (const id of ['p1','a1']) move(w,id,'yard');
  for (let i=0;i<WILD_BERRIES.yard;i+=1) {
    w.t+=2;
    assert.ok(doForage(w,i%2?'a1':'p1').ok);
  }
  w.t+=2;
  assert.equal(doForage(w,'a1').code,'NO_WILD_FOOD');
  assert.equal(s.produce.berry,WILD_BERRIES.yard);
  const copy=()=>loadSurv(structuredClone(dumpSurv(p)),7,options).world;
  const normal=copy(), dry=copy(), cold=copy();
  for (const world of [normal,dry,cold]) world.weather='clear';
  dry.survival.drought=true; dry.survival.water=.1;
  cold.survival.disasterToday='coldsnap';
  for (let day=1;day<=10;day+=1) for (const world of [normal,dry,cold]) regrowWildBerries(world,day);
  assert.equal(normal.survival.wildBerries.yard,WILD_BERRIES.yard);
  assert.ok(dry.survival.wildBerries.yard<1);
  assert.equal(cold.survival.wildBerries.yard,0);
  assert.ok(doForage(normal,'a1').ok);
  assert.equal(doForage(dry,'p1').code,'NO_WILD_FOOD');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { eventRoll, survivalRoll } from './rng.mjs';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { actuate, affordancesFor, move } from './body.mjs';
import { validate } from './rules.mjs';
import { DAY_TICKS } from './clock.mjs';
import { familyHomeForBirth, ELDER_DAYS, ADULT_DAYS } from './households.mjs';

function correlation(s) {
  const [n,x,y,xx,yy,xy]=s;
  return (n*xy-x*y)/Math.sqrt((n*xx-x*x)*(n*yy-y*y));
}
function add(s,x,y) {
  s[0]++;s[1]+=x;s[2]+=y;s[3]+=x*x;s[4]+=y*y;s[5]+=x*y;
}

test('C01/C02 版本化事件概率分布与同日、跨日、跨种子和跨事件相关性', () => {
  const stats={};
  const types=['elder-death','chicken-birth','orchard-birth','birth-sex'];
  for (const version of [1,2]) for(const [i,type] of types.entries()) {
    const paired=types[(i+1)%types.length];
    const bins=Array(10).fill(0);
    const pairs=Array.from({length:4},()=>Array(6).fill(0));
    const prefix=['a','ch','or','c'][i];
    for(let seed=1;seed<=64;seed++) for(let id=1;id<=12;id++) for(let day=1;day<=128;day++) {
      const roll=(s,t,a,d)=>survivalRoll({seed:s,eventRulesVersion:version},t,a,d);
      const entity=prefix+id,x=roll(seed,type,entity,day);
      assert.ok(x>=0&&x<1);
      assert.equal(x,roll(seed,type,entity,day));
      bins[Math.floor(10*x)]++;
      [roll(seed,type,entity,day+1),roll(seed,type,prefix+(id+1),day),
       roll(seed+1,type,entity,day),roll(seed,paired,entity,day)].forEach((y,j)=>add(pairs[j],x,y));
    }
    const corr=pairs.map(p=>+correlation(p).toFixed(4));
    stats[version+':'+type]={bins,corr};
    if(version===2) {
      assert.ok(bins.every(n=>Math.abs(n/(64*12*128)-.1)<.004));
      assert.ok(corr.every(v=>Math.abs(v)<.025));
    }
  }
  assert.ok(stats['1:chicken-birth'].corr[0]>.9);
  assert.notEqual(eventRoll(7,'a','x',1,0),eventRoll(7,'a','x',1,1));
  console.log(JSON.stringify(stats));
});

test('C05 V2 劳动规则约束候选和实际执行，成年与老年保留各自劳动能力', () => {
  const w=createSurvPlay(7,{eventRulesVersion:2,residentialDecisions:true,autonomousGoals:true}).world;
  const child=w.survival.households.residents.a1;
  move(w,'a1','yard');
  w.survival.sites.push({loc:'yard',type:'shelter',progress:0});
  for (const age of [0,6]) {
    child.born=-age*DAY_TICKS;
    assert.equal(validate(w,'a1',{kind:'build'}).code,'TOO_YOUNG');
    assert.equal(actuate(w,'a1',{kind:'gather'}).code,'TOO_YOUNG');
    assert.ok(!affordancesFor(w,'a1').some(a=>a.goal||['gather','build'].includes(a.kind)));
    assert.ok(affordancesFor(w,'a1').some(a=>a.kind==='rest'));
  }
  child.born=-ADULT_DAYS*DAY_TICKS;
  assert.ok(actuate(w,'a1',{kind:'build'}).ok);
  assert.equal(w.survival.sites[0].progress,2);
  child.born=-ELDER_DAYS*DAY_TICKS;
  assert.ok(actuate(w,'a1',{kind:'build'}).ok);
  assert.equal(w.survival.sites[0].progress,3);
});

test('C05/C11 V2 婚育仅限成年，子代身份、性别及版本跨档',async()=>{
  const options={eventRulesVersion:2,residentialDecisions:true};
  const p=createSurvPlay(7,options),w=p.world,h=w.survival.households;
  h.spouses.a1='a2';h.spouses.a2='a1';w.housing.a2=w.housing.a1;
  h.residents.a1.born=-ELDER_DAYS*DAY_TICKS;
  assert.equal(familyHomeForBirth(w,'a1','a2'),null);
  h.residents.a1.born=-ADULT_DAYS*DAY_TICKS;
  assert.ok(familyHomeForBirth(w,'a1','a2'));
  w.t=DAY_TICKS-1;
  w.survival.store=24;
  await tickSurvPlay(p);
  const child=h.residents.c1;
  assert.deepEqual(child.parents,['a1','a2']);
  assert.equal(w.sex.c1,eventRoll(7,'birth-sex','c1',1)<.5?'M':'F');
  const raw=structuredClone(dumpSurv(p)),restored=loadSurv(raw,7,options);
  assert.equal(restored.world.eventRulesVersion,2);
  assert.equal(restored.world.sex.c1,w.sex.c1);
  assert.deepEqual(restored.world.survival.households.residents.c1,child);
  delete raw.eventRulesVersion;
  assert.equal(loadSurv(raw,7,options).world.eventRulesVersion,1);
  assert.equal(loadSurv(undefined,7,options).world.eventRulesVersion,2);
});


test('C08/C09 生存通道负控只切断调节、记忆评分与习惯选择', async () => {
  const options = { eventRulesVersion: 2, independentWorld: true };
  const baseline = createSurvPlay(7, options);
  const off = createSurvPlay(7, { ...options, residentChannelMask: { driveRegulation: 0, mem: 0, habitChoice: 0 } });
  const counts = [0, 0];
  for (const [i, sp] of [baseline, off].entries()) {
    const a = sp.world.agents.a1;
    const regulate = a.drives.regulate.bind(a.drives);
    a.drives.regulate = (...args) => { counts[i] += 1; return regulate(...args); };
    for (let tick = 0; tick < 96; tick++) await tickSurvPlay(sp);
  }
  assert.deepEqual(counts, [96, 0]);
  assert.ok(baseline.world.agents.a1.counters.habit > 0);
  const actor = off.world.agents.a1;
  assert.equal(actor.counters.habit, 0);
  assert.ok(Object.keys(actor.habit.dump().rows).length > 0);
  assert.ok(actor.memory.rows.length > 0);
  assert.ok(actor.trace.some(row => row.parts));
  assert.ok(actor.trace.every(row => !row.parts || row.parts['记忆'] === 0));
});

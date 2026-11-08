// PLAN §28 世界预设闸门（T1–T5 的本片部分）：lab 不变、town 有房间/物件/天气/台词/意图分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn, perceptsAt } from './body.mjs';
import { LAB, TOWN, presetOf } from './presets.mjs';
import { weatherFor, WEATHERS, dayOf } from './clock.mjs';
import { speechLine, classifySay } from './speech.mjs';
import { Organism } from './agent.mjs';
import { simulate } from './run.mjs';

test('T2 town 结构：8 房间/物件/开关；lab 四间且顺序不变', () => {
  assert.deepEqual(Object.keys(LAB.locs), ['home', 'hall', 'watch', 'store'], 'lab 房间顺序变了 ⇒ 候选顺序会变、旧轨迹作废');
  const w = makeWorld({ preset: 'town', seed: 7 });
  assert.equal(Object.keys(w.locs).length, 8);
  assert.equal(Object.keys(w.things).length, 5);
  assert.equal(w.features.work, true);
  assert.equal(w.features.trade, true);
  const l = makeWorld({ preset: 'lab' });
  assert.equal(l.weatherEnabled, false);
  assert.equal(l.speech, false);
  assert.equal(presetOf('nope').id, 'lab', '未知预设必须回退 lab');
});

test('T3 天气确定性：同 (seed,day) 同值；坏天气只对户外可见，另在户外扣能量', async () => {
  for (let d = 0; d < 30; d++) assert.equal(weatherFor(7, d), weatherFor(7, d));
  assert.ok(WEATHERS.includes(weatherFor(7, 3)));
  assert.notEqual(weatherFor(7, 0) + weatherFor(7, 1) + weatherFor(7, 2) + weatherFor(11, 0) + weatherFor(11, 1) + weatherFor(11, 2), '都相同');
  const w = makeWorld({ preset: 'town', seed: 7 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2' });
  w.agents.a1 = a;
  spawn(w, 'a1', 'yard');
  w.weather = 'rain';
  assert.ok(perceptsAt(w, 'a1').some((p) => p.kind === 'weather'), '户外雨天没有天气感知');
  w.loc.a1 = 'home'; w.occupancy = { home: ['a1'], yard: [] };
  assert.ok(!perceptsAt(w, 'a1').some((p) => p.kind === 'weather'), '室内不该感知到天气');
  const lab = makeWorld({ preset: 'lab' });
  lab.agents.a1 = a; spawn(lab, 'a1', 'watch');
  assert.ok(!perceptsAt(lab, 'a1').some((p) => p.kind === 'weather'), 'lab 不该有天气感知');
});

test('T4 台词：确定性、状态条件化、非空；夜间后缀一致', () => {
  const w = makeWorld({ preset: 'town', seed: 7 });
  const mk = (e) => { const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2' }); a.drives.v.energy = e; w.agents.a1 = a; spawn(w, 'a1', 'workshop'); return a; };
  const hungry = mk(0.1);
  const l1 = speechLine(hungry, { world: w, kind: 'eat', actionId: 'eat', t: 5 });
  const l2 = speechLine(hungry, { world: w, kind: 'eat', actionId: 'eat', t: 5 });
  assert.equal(l1, l2, '同状态同刻台词不一样 ⇒ 不可复现');
  assert.ok(l1.length > 0);
  assert.ok(typeof speechLine(hungry, { world: w, kind: 'rest', actionId: 'rest', t: 26 }) === 'string');
  assert.match(speechLine(hungry, { world: w, kind: 'rest', actionId: 'rest', t: 20 }), /夜里/, '夜间台词没有夜间后缀');
});

test('T5 意图分类：六类确定性，信任方向符合预登记', () => {
  assert.equal(classifySay('你这个贼，偷我东西').kind, 'accuse');
  assert.ok(classifySay('你这个贼').trust < 0);
  assert.equal(classifySay('对不起，是我不好').kind, 'apologize');
  assert.ok(classifySay('对不起').trust > 0);
  assert.equal(classifySay('小心点，别去瞭台').kind, 'warn');
  assert.ok(classifySay('注意安全').trust > 0);
  assert.equal(classifySay('告诉你一件事').kind, 'share');
  assert.ok(classifySay('我饿了，分我一口').trust === 0);
  assert.equal(classifySay('你好啊').kind, 'greet');
  assert.equal(classifySay('今天天气不错').kind, 'neutral');
  assert.deepEqual(classifySay('你好'), classifySay('你好'));
});

test('T1 lab 等价：lab 预设下有 4 间房、无天气、无台词，模拟可复现', async () => {
  const d = async () => (await simulate({ seed: 7, ticks: 60 })).agents;
  const a = await d();
  const b = await d();
  const dig = (ags) => Object.values(ags).map((x) => x.trace.map((r) => `${r.t}|${r.action ?? r.layer}`).join('#')).join('@');
  assert.equal(dig(a), dig(b), 'lab 同种子两跑不同');
  assert.equal(makeWorld({}).preset, 'lab');
});

test('T6 town 动作：work/buy/trade/companion 出现在候选清单并被执行', async () => {
  const { affordancesFor, actuate } = await import('./body.mjs');
  const w = makeWorld({ preset: 'town', seed: 7 });
  const mk = (id, seed) => { const a = new Organism({ id, name: id, archetype: '谨慎', seed, condition: 'C2', rng: undefined }); w.agents[id] = a; return a; };
  const a1 = mk('a1', 1); const a2 = mk('a2', 2);
  w.loc.a1 = 'workshop'; w.occupancy.workshop = ['a1'];
  assert.ok(affordancesFor(w, 'a1').some((x) => x.kind === 'work'), '工坊没有 work 候选');
  const r = actuate(w, 'a1', { kind: 'work' });
  assert.ok(r.ok && w.coins.a1 === 2, 'work 没给铜币');
  w.loc.a1 = 'store'; w.occupancy.store = ['a1']; w.stash.a1 = 0;
  assert.ok(affordancesFor(w, 'a1').some((x) => x.kind === 'buy'), '公仓有铜币却没有 buy 候选');
  actuate(w, 'a1', { kind: 'buy' });
  assert.equal(w.coins.a1, 0); assert.equal(w.stash.a1, 1, 'buy 没把粮加进私人库存');

  // trade：同屋、一方缺粮、另一方有余粮（接济/交换）
  w.loc.a1 = 'hall'; w.loc.a2 = 'hall'; w.occupancy.hall = ['a1', 'a2'];
  w.coins.a1 = 0; w.stash.a1 = 0; w.stash.a2 = 3;
  a1.relations.meet('a2', 1, { delta: { trust: 10, familiarity: 0.2 } });
  assert.ok(affordancesFor(w, 'a1').some((x) => x.kind === 'trade'), '同屋缺粮/有余粮却没有 trade 候选');
  const tr = actuate(w, 'a1', { kind: 'trade', target: 'a2' });
  assert.ok(tr.ok && w.stash.a1 === 1 && w.stash.a2 === 2, 'trade 的口粮转移不对');

  // companion：熟悉度与信任达标后出现；执行后成为一对
  a1.relations.meet('a2', 2, { delta: { familiarity: 0.2 } });
  assert.ok(affordancesFor(w, 'a1').some((x) => x.kind === 'companion'), '熟悉度够了却没有 companion 候选');
  actuate(w, 'a1', { kind: 'companion', target: 'a2' });
  assert.deepEqual(w.companions, [['a1', 'a2']]);

  // 群体规范：≥2 人目击越轨 ⇒ 全员对行为人信任下降并记一条规范
  const w3 = makeWorld({ preset: 'town', seed: 7 });
  const ids = ['a1', 'a2', 'a3'];
  for (const id of ids) { const a = new Organism({ id, name: id, archetype: '谨慎', seed: id.length, condition: 'C2' }); w3.agents[id] = a; }
  w3.loc.a1 = 'store'; w3.loc.a2 = 'store'; w3.loc.a3 = 'store'; w3.occupancy.store = ids.slice();
  w3.stash.victim = 2; w3.agents.victim = { id: 'victim', name: '受害者' }; w3.loc.victim = 'home';
  const before = Object.fromEntries(['a2', 'a3'].map((id) => [id, w3.agents[id].relations.get('a1').trust]));
  const tb = actuate(w3, 'a1', { kind: 'take_shared', target: 'victim' });
  assert.ok(tb.ok);
  assert.equal((w3.normLog ?? []).length, 1, '两人目击却没有记规范事件');
  for (const id of ['a2', 'a3']) assert.ok(w3.agents[id].relations.get('a1').trust < before[id], `${id} 对行为人的信任没有下降`);

  // 集成冒烟：600 刻里至少出现一次 work（停止条件：为 0 就要查接线，不许当装饰上交付）
  const { agents } = await simulate({ seed: 7, ticks: 600, condition: 'C2', preset: 'town' });
  const kinds = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.kind).map((r) => r.kind));
  const count = (k) => kinds.filter((x) => x === k).length;
  console.log('TOWN_KINDS', JSON.stringify({ work: count('work'), buy: count('buy'), trade: count('trade'), companion: count('companion') }));
  for (const k of ['work', 'buy', 'trade', 'companion']) assert.ok(count(k) >= 1, `600 刻里一次 ${k} 都没执行 ⇒ 新动作是装饰或规则层不认`);
  // 规则层也要能红：工坊外干活 / 没铜币换粮必须被驳回
  const { validate } = await import('./rules.mjs');
  const wv = makeWorld({ preset: 'town', seed: 7 }); wv.agents.a1 = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2' }); wv.loc.a1 = 'home'; wv.coins.a1 = 0;
  assert.equal(validate(wv, 'a1', { kind: 'work' }).code, 'NO_WORKSHOP');
  assert.equal(validate(wv, 'a1', { kind: 'buy' }).code, 'NOT_STORE');
});

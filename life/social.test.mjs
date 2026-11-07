// M7 自发转述（第三人声誉）的判据。默认关；开启时走既有 ⑨ 通道语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn, addSecret } from './body.mjs';
import { socialRound } from './social.mjs';
import { Organism } from './agent.mjs';
import { simulate } from './run.mjs';

const room = (condition = 'C2', channelMask = null) => {
  const w = makeWorld({ pantries: 6, stash: 3, socialGossip: 1 });
  const mk = (id, name, seed) => new Organism({ id, name, archetype: '谨慎', seed, condition, channelMask });
  w.agents.a1 = mk('a1', '岑', 1);
  w.agents.a2 = mk('a2', '绛', 2);
  w.agents.a3 = mk('a3', '蓑', 3);
  for (const id of ['a1', 'a2', 'a3']) spawn(w, id, 'hall');
  const s = addSecret(w, { kind: 'theft', about: 'a3', holder: 'a3', valence: -0.6, violates: 'order', detail: '蓑 从别人门口拿走一份' });
  s.known.add('a1'); // 只有 a1 知道
  return { w, s };
};

test('M7 第三人声誉：同处一室时，知道的人把关于第三者的秘密讲出去，听者对其信任下降', () => {
  const { w, s } = room();
  const before = w.agents.a2.relations.get('a3').trust;
  const told = socialRound(w);
  assert.equal(told.length, 1, `一轮应传出一条，实测 ${told.length} ⇒ 转述没发生`);
  assert.ok(s.known.has('a2'), '听者没有登记这条秘密 ⇒ 认知没更新');
  assert.ok(w.agents.a2.relations.get('a3').trust < before, `听者对持有者信任未下降（${before} → ${w.agents.a2.relations.get('a3').trust}）⇒ 第三人声誉只是登记`);
});

test('M7 负控：切断 ⑨ 通道时，登记照旧、信任不变（后果与认知分开）', () => {
  const { w, s } = room('C2', { gossip: 0 });
  const before = w.agents.a2.relations.get('a3').trust;
  socialRound(w);
  assert.ok(s.known.has('a2'), '通道切断后连登记都停了 ⇒ 切错了位置，应当只切后果');
  assert.equal(w.agents.a2.relations.get('a3').trust, before, '⑨ 切断后信任仍下降 ⇒ 负控不干净');
});

test('M7 规则不破：不知道的人不能转述，秘密不传给当事人', () => {
  const { w } = room();
  // a2 不知道，让 a2 当 teller 什么也传不出去
  const w2 = makeWorld({ pantries: 6, stash: 3, socialGossip: 1 });
  for (const id of ['a1', 'a2']) {
    w2.agents[id] = new Organism({ id, name: id, archetype: '谨慎', seed: 9, condition: 'C2' });
    spawn(w2, id, 'hall');
  }
  addSecret(w2, { kind: 'theft', about: 'a1', holder: 'a1', valence: -0.6, violates: 'order', detail: 'x' });
  assert.equal(socialRound(w2).length, 0, '无人知情却传出消息 ⇒ 规则层没被走');
});

test('M7 关闭时与基线一致：传闻计数为 0，且同种子两跑逐位相同', async () => {
  const a = await simulate({ seed: 7, ticks: 300, socialGossip: 0 });
  const b = await simulate({ seed: 7, ticks: 300, socialGossip: 0 });
  const seq = (x) => Object.values(x.agents).map((ag) => ag.trace.map((r) => `${r.t}:${r.kind}:${r.action}`).join('|')).join('#');
  assert.equal(seq(a), seq(b), '关闭时两跑结果不同 ⇒ 引入的层破坏了可复现');
});

test('M7 开启可复现：同种子两跑的 known 集合与行为序列逐位相同', async () => {
  const a = await simulate({ seed: 7, ticks: 300, socialGossip: 1 });
  const b = await simulate({ seed: 7, ticks: 300, socialGossip: 1 });
  const known = (x) => (x.world.secrets ?? []).map((s) => [...s.known].sort().join(',')).join(';');
  const seq = (x) => Object.values(x.agents).map((ag) => ag.trace.map((r) => `${r.t}:${r.kind}:${r.action}`).join('|')).join('#');
  const extra = (x) => (x.world.secrets ?? []).reduce((s, sec) => s + Math.max(0, sec.known.size - 1), 0);
  assert.ok(extra(a) > 0, '开启后没有任何转述发生 ⇒ simulate 钩子没接上，这层在空转');
  assert.equal(known(a), known(b), '同种子两跑的知情集合不同 ⇒ 转述顺序不确定');
  assert.equal(seq(a), seq(b), '同种子两跑行为序列不同 ⇒ 不可复现');
});

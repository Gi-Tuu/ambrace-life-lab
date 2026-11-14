// 对话层闸门：居民有权不理、走开、发火甚至动手；模型只负责措辞，不负责态度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, survView, tickSurvPlay } from './survplay.mjs';
import { move } from './body.mjs';
import { openTalk, sayTo, closeTalk } from './dialogue.mjs';

function setup() {
  const sp = createSurvPlay(7);
  const w = sp.world, a1 = w.agents.a1;
  w.loc.a1 = 'home';
  move(w, 'p1', 'home');
  a1.relations.get('p1').trust = 60;
  a1.drives.v.energy = 0.8;
  a1.drives.v.social = 0.4;
  delete a1.last;
  return { sp, w, a1 };
}

test('对话必须在同一地点打开；社交已满足的居民会拒绝交谈', async () => {
  const { sp, w, a1 } = setup();
  w.loc.a1 = 'watch'; move(w, 'a1', 'watch');
  assert.equal(openTalk(sp, { target: 'a1' }).code, 'NOT_TOGETHER');
  move(w, 'a1', 'home'); w.loc.a1 = 'home';
  a1.drives.v.social = 0.9;
  const r = openTalk(sp, { target: 'a1' });
  assert.equal(r.ok, true);
  assert.equal(r.engage, 'refuse');
  let called = false;
  const t = await sayTo(sp, { target: 'a1', text: '你好' }, async () => { called = true; return '不该出现'; });
  assert.equal(t.ignored, true);
  assert.equal(called, false, '拒绝交谈时不应烧模型额度');
});

test('打字太久：居民不耐烦离开，对话自动结束', async () => {
  const { sp, w } = setup();
  assert.equal(openTalk(sp, { target: 'a1' }).engage, 'open');
  sp.world.survival.talk.openAt = Date.now() - 60000;
  const r = await sayTo(sp, { target: 'a1', text: '在吗' }, null);
  assert.equal(r.left, true);
  assert.equal(sp.world.survival.talk, null);
  assert.notEqual(w.loc.a1, 'home', '应真的走开（世界位置改变）');
});

test('被辱骂且信任低：发火、动手，玩家掉存续', async () => {
  const { sp, w, a1 } = setup();
  a1.relations.get('p1').trust = 10;
  a1.traits.archetype = '冲动';
  assert.equal(openTalk(sp, { target: 'a1' }).ok, true);
  const before = w.agents.p1.viab.v;
  const r = await sayTo(sp, { target: 'a1', text: '滚，废物' }, async () => '（不该被调用）');
  assert.equal(r.hostile, true);
  assert.equal(r.attacked, true);
  assert.ok(w.agents.p1.viab.v < before, '攻击必须造成存续损失');
  assert.equal(sp.world.survival.talk, null, '动手后对话结束');
});

test('正常回应走模型；没有模型时退模板，关系仍按关键词变化', async () => {
  const { sp, a1 } = setup();
  openTalk(sp, { target: 'a1' });
  const before = a1.relations.get('p1').trust;
  const r = await sayTo(sp, { target: 'a1', text: '对不起，我错了' }, async ({ text }) => `（模型听到：${text}）`);
  assert.equal(r.line, '（模型听到：对不起，我错了）');
  assert.ok(a1.relations.get('p1').trust > before, '道歉应提升信任');
  const r2 = await sayTo(sp, { target: 'a1', text: '今天天气不错' }, null);
  assert.ok(r2.line && !r2.line.includes('模型'), '无模型时应退模板');
  assert.equal(closeTalk(sp).ok, true);
});

test('生存气泡只读取本刻成功的居民交谈，轮询不会改变存档状态', async () => {
  const sp = createSurvPlay(13);
  assert.deepEqual(survView(sp).speech, {});
  await tickSurvPlay(sp);
  const w = sp.world;
  const talk = w.agents.a1.trace.find((act) => act.t === w.t && act.ok && act.kind === 'talk');
  assert.equal(talk?.target, 'a2');
  const before = structuredClone(dumpSurv(sp));
  const speech = survView(sp).speech;
  assert.match(speech.a1, /绛/);
  assert.deepEqual(survView(sp).speech, speech);
  assert.deepEqual(dumpSurv(sp), before);

  talk.ok = false;
  assert.equal(survView(sp).speech.a1, undefined);
  talk.ok = true;
  move(w, 'a2', 'hall');
  assert.equal(survView(sp).speech.a1, undefined);
  move(w, 'a2', w.loc.a1);
  w.t += 1;
  assert.equal(survView(sp).speech.a1, undefined);
});

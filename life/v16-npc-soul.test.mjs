// 1.6 灵魂能力闸门：持久对话记忆（A）+ 居民主动找玩家说话（B）+ 玩家可感知（C）。
// 口径：
//   · 记忆只存在 survival.talkMemory：摘要 ≤200 字/≤3 段、最近 8 条 = 4 轮、单条 ≤120 字；
//     关面板→重开能接上，存档往返/旧档能读，研究/compare 不多字段；
//   · 主动搭话只在正式连续世界（gameRules + simClock + 非 compare + 非离线）触发；
//     靠近 2.5、同空间同地点、每居民每日 ≤2、冷却 360 游戏分、同时 1 条、TTL 15 分；
//   · 模型 fire-and-forget：先落模板，成功后只改 text；失败/超时/空/无效一律保留模板，不报错；
//   · 气泡点击走 fromSpeech：服务端复核同空间 ≤2.5；普通 F 入口仍是 1.6，不放宽。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { buildFreeTalkPrompt } from './resident-dialogue.mjs';
import { maybePlayerSpeech } from './resident-proactive.mjs';
import { worldSite } from './geometry.mjs';
import { simMinuteNow } from './sim-clock.mjs';
import { dayOf } from './clock.mjs';

const GAME = Object.freeze({
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
  simTime: true,
});
const formal = (seed = 7) => createSurvPlay(seed, { ...GAME });

function contactOf(w, target = 'a1') {
  const [x, z] = worldSite(w, w.loc[target]);
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  return { target, room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
}
const open = (p, target = 'a1') => survAct(p, { kind: 'camp_talk', ...contactOf(p.world, target) });
const say = (p, text, target = 'a1') => survAct(p, { kind: 'camp_talk_say', ...contactOf(p.world, target), text });
const close = (p, target = 'a1') => survAct(p, { kind: 'camp_talk_close', target });

function freezeThinks(w) {
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.nextThinkMin = Number.POSITIVE_INFINITY;
}
// 主动搭话只读服务端 pos：测试把玩家/居民放进同一世界空间，避免房间空间混比。
function standNear(w, target = 'a1', gap = 1) {
  const [x, z] = worldSite(w, 'yard');
  w.loc.p1 = 'yard'; w.loc[target] = 'yard';
  w.pos[target] = { x, z, space: 'world' };
  w.pos.p1 = { x: x + gap, z, space: 'world' };
}
function standFar(w, target = 'a1') {
  const [x, z] = worldSite(w, 'yard');
  w.loc.p1 = 'yard'; w.loc[target] = 'yard';
  w.pos[target] = { x, z, space: 'world' };
  w.pos.p1 = { x: x + 40, z, space: 'world' };
}

// ── A：持久对话记忆 ───────────────────────────────────────────────────────────
test('SOUL-01 关面板→重开：摘要/最近轮次还在，prompt 能接“上次…”', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  assert.equal(open(p).code, 'RESIDENT_TALK_OPEN');
  assert.equal(say(p, '昨天我在河边看见你了').ok, true);
  assert.equal(say(p, '今天还去河边吗').ok, true);
  const live = w.survival.talkMemory?.a1;
  assert.ok(live, '对话中/关闭前必须写入 survival.talkMemory.a1');
  assert.ok(live.summary.length > 0, '摘要不能为空');
  assert.ok(live.recent.length >= 4, '最近轮次必须包含玩家与居民的话');
  assert.equal(live.turns, 2);

  close(p);
  assert.equal(w.survival.residentDialogue, undefined);
  const mem = w.survival.talkMemory.a1;
  assert.equal(mem.turns, 2, '关闭后轮次保留');
  assert.ok(mem.summary.includes('河边'), `摘要必须带对话内容：${mem.summary}`);

  const reopened = open(p);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.memory?.summary, mem.summary, '打开响应要带“他还记得”的摘要');
  const session = w.survival.residentDialogue;
  assert.equal(session.summary, mem.summary, '重开会话必须用记忆初始化 summary');
  assert.ok(session.history.length >= 4, '重开会话必须用最近轮次初始化 history');
  assert.equal(session.turns, mem.turns, '轮次跨会话累计');
  const prompt = buildFreeTalkPrompt(w, npc, session, '上次说到哪了？');
  assert.match(prompt, /你们之前聊过/);
  assert.match(prompt, /河边/, '新 prompt 必须能引用上次对话');
});

test('SOUL-02 上限：≤200 字/≤3 段摘要、≤8 条最近轮次、单条 ≤120 字；不写世界/关系', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  const trust0 = npc.relations.get('p1').trust;
  const loc0 = { ...w.loc }, store0 = w.survival.store;
  const busy0 = JSON.stringify(w.survival.actClock?.a1?.busy ?? null);
  for (let round = 0; round < 6; round += 1) {
    open(p);
    say(p, `第${round}轮` + '啊'.repeat(200));
    say(p, `再说${round}` + '嗯'.repeat(200));
    close(p);
    const mem = w.survival.talkMemory.a1;
    assert.ok([...mem.summary].length <= 200, `摘要超 200 字：${[...mem.summary].length}`);
    assert.ok(mem.summary.split('；').filter(Boolean).length <= 3, `摘要超过 3 段：${mem.summary}`);
    assert.ok(mem.recent.length <= 8, `最近轮次超过 8 条：${mem.recent.length}`);
    for (const row of mem.recent) {
      assert.ok([...row.text].length <= 120, `单条记忆超 120 字：${[...row.text].length}`);
      assert.ok(row.who === 'p1' || row.who === 'a1');
      assert.ok(Number.isFinite(row.atMin));
    }
    assert.equal(mem.turns, (round + 1) * 2);
  }
  assert.equal(npc.relations.get('p1').trust, trust0, '记忆不得写关系');
  assert.deepEqual(w.loc, loc0, '记忆不得写 loc');
  assert.equal(w.survival.store, store0, '记忆不得写 store');
  assert.equal(JSON.stringify(w.survival.actClock?.a1?.busy ?? null), busy0, '记忆不得写 busy');
});

test('SOUL-03 入档/旧档/研究形状：记忆随档往返，旧档可读，研究与 compare 不多字段', async () => {
  const p = formal(), w = p.world;
  open(p); say(p, '记得给我留一扇门'); close(p);
  const before = structuredClone(w.survival.talkMemory);
  const dumped = dumpSurv(p);
  assert.ok(dumped.survival.talkMemory?.a1, '记忆必须入档');
  const back = loadSurv(structuredClone(dumped), 7, { ...GAME });
  assert.deepEqual(back.world.survival.talkMemory, before, '存档往返逐位一致');
  assert.equal(back.world.survival.playerSpeech ?? null, null, '瞬态气泡不得随档复活');

  // 旧档：没有 talkMemory / playerSpeech / proactiveTalk，读档不抛，随后还能正常对话。
  const old = structuredClone(dumped);
  delete old.survival.talkMemory;
  delete old.survival.playerSpeech;
  delete old.survival.proactiveTalk;
  const legacy = loadSurv(old, 7, { ...GAME });
  assert.equal(legacy.world.survival.talkMemory, undefined);
  const legacyOpen = open(legacy, 'a1');
  assert.equal(legacyOpen.ok, true, JSON.stringify(legacyOpen));
  assert.equal(say(legacy, '旧档也能聊').ok, true);

  // 研究态：不出现记忆/气泡/居民上次聊天字段。
  const research = createSurvPlay(7, {});
  assert.equal(research.world.survival.talkMemory, undefined);
  assert.equal(survView(research).playerSpeech, undefined);
  assert.equal(survView(research).agents.a1.lastTalk, undefined);
  assert.equal(dumpSurv(research).survival.talkMemory, undefined);

  // compare：即便靠近也不生成主动搭话。
  const compared = formal(11), cw = compared.world;
  standNear(cw); freezeThinks(cw); cw.compareSide = 'A';
  await tickSurvPlay(compared, { minutes: 60 });
  assert.equal(cw.survival.playerSpeech, undefined, 'compare 不得生成主动搭话');
  assert.equal(survView(compared).playerSpeech, undefined);
});

test('SOUL-04 面板/居民面板展示记忆，且不泄露 secrets', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  open(p); say(p, '别告诉别人我把木料藏在井边'); close(p);
  w.secrets = [{ id: 's1', kind: 'stash', detail: '藏了三袋粮', about: 'a1', holder: 'a1', known: new Set(['a1']) }];
  const view = survView(p);
  const lastTalk = view.agents.a1.lastTalk;
  assert.ok(lastTalk, '/world 的居民面板要有上次聊天');
  assert.equal(lastTalk.summary, w.survival.talkMemory.a1.summary);
  assert.equal(lastTalk.turns, 1);
  const shown = JSON.stringify(lastTalk);
  assert.ok(!shown.includes('藏了三袋粮'), '记忆展示不得包含 world.secrets');
  assert.ok(!shown.includes('relations') && !shown.includes('trust'), '记忆展示不得夹带关系明细');
  const reopened = open(p);
  assert.equal(reopened.memory.summary, lastTalk.summary, '面板“他还记得”读同一份记忆');
  assert.ok(npc.relations.get('p1').familiarity >= 0);
});

// ── B：居民主动搭话 ───────────────────────────────────────────────────────────
test('SOUL-05 靠近触发一次：/world 下五字段、模板引用真实状态、TTL 内不重复', async () => {
  const p = formal(), w = p.world;
  standNear(w); freezeThinks(w);
  w.weather = 'rain';
  w.agents.a1.drives.v.energy = 0.2;
  w.survival.eventJournal = { next: 1, rows: [] };
  await tickSurvPlay(p, { minutes: 60 });
  const speech = w.survival.playerSpeech;
  assert.ok(speech, '玩家靠近时没有生成 playerSpeech');
  assert.deepEqual(Object.keys(speech).sort(), ['at', 'expires', 'id', 'name', 'text'], '只能下发 id/name/text/at/expires');
  assert.equal(speech.id, 'a1');
  assert.equal(speech.name, w.agents.a1.name);
  assert.ok(speech.text.length > 0 && [...speech.text].length <= 60);
  assert.ok(speech.expires > speech.at, 'TTL 必须为正');
  assert.ok(/雨|湿|滑|饿|吃|活/.test(speech.text), `模板必须引用真实状态：${speech.text}`);
  assert.ok(survView(p).playerSpeech, '/world 必须下发 playerSpeech');
  assert.equal(survView(p).playerSpeech.text, speech.text);

  const first = speech.text;
  const at = speech.at;
  assert.equal(maybePlayerSpeech(w), null, '同一条气泡有效期内不得再生成');
  assert.equal(w.survival.playerSpeech.text, first);
  w.agents.a1.drives.v.energy = 0.9;
  w.weather = 'clear';
  await tickSurvPlay(p, { minutes: 60 });
  assert.ok(!w.survival.playerSpeech || w.survival.playerSpeech.at === at, '不得刷屏换一条新气泡');
});

test('SOUL-06 冷却/日上限/太远/幽灵/对话中/离线都静默', async () => {
  const p = formal(), w = p.world;
  standNear(w); freezeThinks(w);
  w.loc.a2 = 'garden'; w.pos.a2 = { ...w.pos.a2, x: w.pos.a2.x + 40 };
  w.loc.a3 = 'watch'; w.pos.a3 = { ...w.pos.a3, x: w.pos.a3.x + 40 };
  await tickSurvPlay(p, { minutes: 60 });
  assert.ok(w.survival.playerSpeech, '前置：第一次应触发');
  const day = dayOf(w.t);
  const state = w.survival.proactiveTalk.by.a1;
  assert.equal(state.day, day);
  assert.equal(state.count, 1);
  assert.equal(state.lastServed, 'template');

  // 冷却：清掉气泡，6 小时内不再触发。
  w.survival.playerSpeech = null;
  state.lastAtMin = simMinuteNow(w);
  await tickSurvPlay(p, { minutes: 60 });
  assert.equal(w.survival.playerSpeech ?? null, null, '冷却内不得触发');

  // 冷却到点：再触发一次（仍同日）。
  state.lastAtMin = simMinuteNow(w) - 361;
  await tickSurvPlay(p, { minutes: 60 });
  assert.ok(w.survival.playerSpeech, '冷却到点应再次触发');
  assert.equal(state.count, 2);

  // 日上限：同日第 3 次必须静默。
  w.survival.playerSpeech = null;
  state.lastAtMin = simMinuteNow(w) - 1000;
  await tickSurvPlay(p, { minutes: 60 });
  assert.equal(w.survival.playerSpeech ?? null, null, '每居民每日上限必须生效');

  // 太远：换新居民/新日夹具，仍不触发。
  const far = formal(13), fw = far.world;
  standFar(fw); freezeThinks(fw);
  await tickSurvPlay(far, { minutes: 60 });
  assert.equal(fw.survival.playerSpeech, undefined, '太远不得触发');

  // 幽灵：不触发、不抛。
  const ghost = formal(17), gw = ghost.world;
  standNear(gw); freezeThinks(gw); gw.survival.playerDead = true;
  await tickSurvPlay(ghost, { minutes: 60 });
  assert.equal(gw.survival.playerSpeech, undefined, '幽灵不得触发');

  // 同一居民的会话进行中：不触发。
  const talking = formal(19), tw = talking.world;
  standNear(tw); freezeThinks(tw);
  assert.equal(open(talking).ok, true);
  await tickSurvPlay(talking, { minutes: 60 });
  assert.equal(tw.survival.playerSpeech, undefined, '与同一居民对话中不得插话');
  close(talking);

  // 离线补时：不触发。
  const offline = formal(23), ow = offline.world;
  standNear(ow); freezeThinks(ow);
  await tickSurvPlay(offline, { minutes: 60, offline: true });
  assert.equal(ow.survival.playerSpeech, undefined, '离线补时不得生成主动搭话');
});

test('SOUL-07 模型异步：先模板后替换、tick 不等；失败/空/无效/过期都保留模板', async () => {
  const p = formal(), w = p.world;
  standNear(w); freezeThinks(w);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  w.playerSpeechModel = async () => { calls += 1; await gate; return '  “我刚收工，你来得正好。”  '; };
  const started = Date.now();
  await tickSurvPlay(p, { minutes: 60 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `tick 被模型等待阻塞：${elapsed}ms`);
  const speech = w.survival.playerSpeech;
  assert.ok(speech?.text, '模型在途时也必须先落模板');
  const template = speech.text;
  assert.equal(speech.text, template);
  assert.ok(w.playerSpeechPending, '模型任务必须挂在 world.playerSpeechPending 供收尾');
  release();
  await w.playerSpeechPending;
  assert.equal(calls, 1);
  assert.equal(w.survival.playerSpeech.text, '我刚收工，你来得正好。', '模型成功后只替换 text');
  assert.equal(w.survival.proactiveTalk.by.a1.lastServed, 'model');

  // 失败：保留模板，不抛错。
  const fail = formal(11), fw = fail.world;
  standNear(fw); freezeThinks(fw);
  fw.playerSpeechModel = async () => { throw new Error('模型挂了'); };
  await tickSurvPlay(fail, { minutes: 60 });
  const failTemplate = fw.survival.playerSpeech.text;
  await fw.playerSpeechPending;
  assert.equal(fw.survival.playerSpeech.text, failTemplate);
  assert.equal(fw.survival.proactiveTalk.by.a1.lastServed, 'template');

  // 空/无效：保留模板。
  const empty = formal(13), ew = empty.world;
  standNear(ew); freezeThinks(ew);
  ew.playerSpeechModel = async () => '{"id":"rest","reason":"夹具"}';
  await tickSurvPlay(empty, { minutes: 60 });
  const emptyTemplate = ew.survival.playerSpeech.text;
  await ew.playerSpeechPending;
  assert.equal(ew.survival.playerSpeech.text, emptyTemplate, '无效模型输出必须退模板');

  // 迟到：气泡已过期就丢弃模型改写。
  const late = formal(17), lw = late.world;
  standNear(lw); freezeThinks(lw);
  let releaseLate;
  const lateGate = new Promise((resolve) => { releaseLate = resolve; });
  lw.playerSpeechModel = async () => { await lateGate; return '迟到的句子'; };
  await tickSurvPlay(late, { minutes: 60 });
  const lateTemplate = lw.survival.playerSpeech.text;
  lw.survival.playerSpeech.expires = simMinuteNow(lw) - 1;
  releaseLate();
  await lw.playerSpeechPending;
  assert.equal(lw.survival.playerSpeech.text, lateTemplate, '过期气泡不得被迟到模型改写');
});

test('SOUL-08 fromSpeech：2.5 格开面板与续聊；普通 F 仍 1.6；走远拒绝', async () => {
  const p = formal(), w = p.world;
  standNear(w, 'a1', 2.2); freezeThinks(w);
  await tickSurvPlay(p, { minutes: 60 });
  const speech = w.survival.playerSpeech;
  assert.ok(speech, '前置：2.2 格内应触发主动搭话');

  // 普通 F 入口不放宽：2.2 格必须拒绝。
  const [x, z] = worldSite(w, 'yard');
  const normal = survAct(p, { kind: 'camp_talk', target: 'a1', room: null, from: [x + 2.2, z], to: [x, z] });
  assert.equal(normal.code, 'RESIDENT_OUT_OF_REACH', '普通入口仍是 1.6，不得被 fromSpeech 放宽');

  // 点击气泡：同空间 ≤2.5 可以打开，并清掉气泡。
  const clicked = survAct(p, { kind: 'camp_talk', target: 'a1', fromSpeech: speech.id });
  assert.equal(clicked.ok, true, `点击气泡打不开对话：${JSON.stringify(clicked)}`);
  assert.equal(w.survival.playerSpeech ?? null, null, '气泡被点开后必须清空');
  assert.ok(w.survival.residentDialogue?.fromSpeech, '会话要记住它是气泡打开的');

  // 续聊：不带客户端接触坐标，服务端按 2.5 复核。
  const reply = survAct(p, { kind: 'camp_talk_say', target: 'a1', fromSpeech: 'a1', text: '我过来了' });
  assert.equal(reply.ok, true, `fromSpeech 续聊被拒：${JSON.stringify(reply)}`);

  // 走远：同一个气泡编号也不能隔空开。
  const far = formal(11), fw = far.world;
  standNear(fw, 'a1', 2.2); freezeThinks(fw);
  await tickSurvPlay(far, { minutes: 60 });
  const farSpeech = fw.survival.playerSpeech;
  fw.pos.p1 = { ...fw.pos.p1, x: fw.pos.p1.x + 20 };
  const farOpen = survAct(far, { kind: 'camp_talk', target: 'a1', fromSpeech: farSpeech.id });
  assert.equal(farOpen.code, 'RESIDENT_OUT_OF_REACH', '走远后气泡不得隔空打开');
});



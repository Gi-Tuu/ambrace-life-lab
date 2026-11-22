// 1.7 统一 NPC 长期记忆闸门：
//   MEM-01 记录形状/非法丢弃/nextId 单调；
//   MEM-02 四通道检索 + 与旧 EpisodicMemory 决策逐位一致 + 承诺能影响决策；
//   MEM-03 超过 4 轮的旧事能被问出（跨会话）；
//   MEM-04 承诺不忘（跨天 + 600 上限淘汰后仍在）；
//   MEM-05 来源可追（亲历/听说/玩家），view 不泄露 secrets/关系；
//   MEM-06 上限/分层保留/衰减淘汰；
//   MEM-07 旧档迁移幂等（memory.rows + talkMemory 迁移，无 Date.now）；
//   MEM-08 存档往返、研究态无字段、正式档被研究态读入也不漏；
//   MEM-09 prompt 预算：尾行/当前输入永不截断；
//   MEM-10 面板 view 字段白名单与来源/时间；
//   MEM-11 决策提示词走同一检索入口（研究态不出现）；
//   MEM-12 主动搭话读统一记忆。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, loadSurv, survAct, survView, tickSurvPlay } from './survplay.mjs';
import { worldSite } from './geometry.mjs';
import { buildFreeTalkPrompt } from './resident-dialogue.mjs';
import { proactiveTemplate } from './resident-proactive.mjs';
import { tell } from './gossip.mjs';
import { EpisodicMemory } from './memory.mjs';
import { affordancesFor } from './body.mjs';
import {
  NPC_MEMORY, newContainer, addEntry, recordDialogueTurn, recordCommitment, recordKnowledge,
  retrieve, decisionRank, stateBonus as npcStateBonus, normalizeContainer, memoryPanelView,
  decisionRecallLines, openCommitments, commitmentFromText, ensureNpcMemory, isOpenCommitment,
} from './npc-memory.mjs';

const GAME = Object.freeze({
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
});
// 正式连续世界：统一记忆只在 gameRules + simClock 下启用（legacy-formal 研究基线保持逐位不变）。
const formal = (seed = 7) => createSurvPlay(seed, { ...GAME, simTime: true });
const LOAD = Object.freeze({ ...GAME, simTime: true });

function contactOf(w, target = 'a1') {
  const [x, z] = worldSite(w, w.loc[target]);
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  return { target, room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
}
const open = (p, target = 'a1') => survAct(p, { kind: 'camp_talk', ...contactOf(p.world, target) });
const say = (p, text, target = 'a1') => survAct(p, { kind: 'camp_talk_say', ...contactOf(p.world, target), text });
const close = (p, target = 'a1') => survAct(p, { kind: 'camp_talk_close', target });

function cloneMemory(agent) {
  const memory = new EpisodicMemory();
  memory.rows = structuredClone(agent.memory.rows);
  memory.failures = new Map(agent.memory.failures);
  memory.kCap = agent.memory.kCap;
  return memory;
}

test('MEM-01 记录形状：四类 kind、source 三态、非法条目丢弃、id 单调', () => {
  const c = newContainer('a1', 24);
  assert.equal(addEntry(c, { at: 1, kind: 'episode', summary: '做完一段活', source: '亲历', importance: 0.6 }).id, 0);
  assert.equal(addEntry(c, { at: 2, kind: 'dialogue', summary: '你来了', source: '玩家', importance: 0.2, state: { who: 'p1', atMin: 2 } }).id, 1);
  assert.equal(addEntry(c, { at: 3, kind: 'commitment', summary: '答应给一根木头', source: '玩家', importance: 0.8, state: { status: 'open', by: 'p1', to: 'a1', actionKind: 'talk' } }).id, 2);
  assert.equal(addEntry(c, { at: 4, kind: 'knowledge', summary: '听说a2家添了孩子', source: '听说:a3', importance: 0.5 }).id, 3);
  // 非法：未知 kind / 空摘要 / 负时间 / 未知 source 回落亲历。
  assert.equal(addEntry(c, { at: 5, kind: 'nope', summary: 'x' }), null);
  assert.equal(addEntry(c, { at: 6, kind: 'episode', summary: '   ' }), null);
  assert.equal(addEntry(c, { at: -1, kind: 'episode', summary: 'x' }), null);
  const weird = addEntry(c, { at: 7, kind: 'episode', summary: 'x', source: '外星' });
  assert.equal(weird.source, '亲历');
  // 往返幂等 + nextId 单调。
  const back = normalizeContainer(JSON.parse(JSON.stringify(c)), 'a1', 24);
  assert.deepEqual(back, c);
  assert.ok(back.nextId > Math.max(...back.entries.map((e) => e.id)));
  // 承诺检测只认显式句式。
  assert.equal(commitmentFromText('今天天气不错'), null);
  const promise = commitmentFromText('我明天一定给你带木头', { at: 10, dayTicks: 24 });
  assert.ok(promise && promise.actionKind === 'talk' && promise.dueAt === 34, JSON.stringify(promise));
});

test('MEM-02 决策：episode 排序与旧 retrieve 逐位一致；承诺给定向 bonus', async () => {
  const p = formal(), w = p.world;
  for (let i = 0; i < 12; i += 1) await tickSurvPlay(p, { minutes: 60 });
  const npc = w.agents.a1;
  ensureNpcMemory(w, npc);
  assert.ok(npc.npcMemory?.entries.length > 0, '正式世界没有建立统一记忆容器');
  const candidates = affordancesFor(w, 'a1');
  const legacyTop = cloneMemory(npc).retrieve(npc.bank.m, candidates, w.t, 6, {});
  const unifiedTop = decisionRank(npc.npcMemory, cloneMemory(npc), npc.bank.m, candidates, w.t, {});
  assert.deepEqual(unifiedTop.map((row) => row.entry.state.rid), legacyTop.map((row) => row.r.id),
    '统一 episode 排序与旧 retrieve 不一致（golden/compare 会漂移）');
  const legacy = cloneMemory(npc).stateBonus(npc.bank.m, candidates, w.t, { stateChannel: true });
  const unified = npcStateBonus(npc.npcMemory, cloneMemory(npc), npc.bank.m, candidates, w.t, { stateChannel: true });
  assert.deepEqual(unified, legacy, '统一 stateBonus 与旧 stateBonus 不是逐位一致');
  // 承诺进入决策：有 open 承诺 + talk 候选 ⇒ 只对承诺登记的 kind 加固定小量。
  recordCommitment(npc.npcMemory, { at: w.t, summary: '答应过：明天给a1带木头', by: 'p1', to: 'a1', dueAt: w.t + 24, actionKind: 'talk' });
  const withTalk = npcStateBonus(npc.npcMemory, cloneMemory(npc), npc.bank.m, [...candidates, { kind: 'talk' }], w.t, { stateChannel: true });
  assert.ok(withTalk.bonus.talk >= NPC_MEMORY.commitmentBonus, `承诺没有影响决策 bonus：${JSON.stringify(withTalk.bonus)}`);
  assert.ok((legacy.bonus.talk ?? 0) < withTalk.bonus.talk, '旧路径不应因为承诺凭空多出 bonus');
});

test('MEM-03 超过 4 轮的旧事能被问出（跨会话 + 检索段，不在最近段）', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  assert.equal(open(p).ok, true);
  for (let i = 1; i <= 12; i += 1) assert.equal(say(p, `暗号第${i}号`).ok, true, `第${i}轮失败`);
  close(p);
  assert.equal(open(p).ok, true);
  const session = w.survival.residentDialogue;
  assert.ok(session.history.length >= 8, `重开会话只 hydrate 了 ${session.history.length} 条`);
  const prompt = buildFreeTalkPrompt(w, npc, session, '上次说过的暗号第2号是什么？');
  const hit = prompt.split('\n').find((line) => line.includes('第2号'));
  assert.ok(hit, `旧事没有进 prompt：${prompt.slice(0, 400)}`);
  assert.ok(hit.startsWith('· ['), `旧事必须来自检索段（带来源/时间），实测：${hit}`);
  const recentLines = prompt.split('\n').filter((line) => line.startsWith('对方：') || line.startsWith(`${npc.name}：`));
  assert.ok(!recentLines.some((line) => line.includes('第2号')), '第 2 轮不应在当前离线最近窗口里');
  assert.ok(prompt.includes('你记得的旧事'), '检索段标题缺失');
  assert.ok([...prompt].length <= 2200, `prompt 超预算：${[...prompt].length}`);
});

test('MEM-04 承诺不忘：跨天 + 700 条填充触发淘汰后仍在，并能被问出', async () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  assert.equal(open(p).ok, true);
  assert.equal(say(p, '我明天一定给你带木头').ok, true);
  close(p);
  const container = npc.npcMemory ?? w.survival.npcMemory?.a1;
  assert.ok(openCommitments(container).length >= 1, '承诺没有写进统一记忆');
  for (let i = 0; i < 24; i += 1) await tickSurvPlay(p, { minutes: 60 });
  for (let i = 0; i < 700; i += 1) {
    recordDialogueTurn(container, { at: w.t, atMin: 0, who: 'p1', text: `填充句 ${i} 号`, importance: 0.1 });
  }
  assert.ok(container.entries.length <= NPC_MEMORY.maxEntries, `超过上限：${container.entries.length}`);
  assert.ok(openCommitments(container).some((e) => e.summary.includes('木头')), '重要承诺被普通窗口挤掉了');
  const asked = retrieve(container, { t: w.t, query: '你答应过我什么' }, { chars: 400, maxEntries: 5, kinds: ['commitment', 'dialogue'] });
  assert.ok(asked.entries.some((e) => e.kind === 'commitment'), '承诺检索不到');
  assert.equal(open(p).ok, true);
  const prompt = buildFreeTalkPrompt(w, npc, w.survival.residentDialogue, '你答应过我什么？');
  assert.match(prompt, /答应过/, '承诺没有进入对话 prompt');
});

test('MEM-05 来源可追：亲历/听说/玩家三态，view 不泄露 secrets 与关系', async () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  await tickSurvPlay(p, { minutes: 60 });
  const container = npc.npcMemory ?? w.survival.npcMemory?.a1;
  assert.ok(container.entries.some((e) => e.source === '亲历' && e.kind === 'episode'), '没有亲历事件');
  // 听说：gossip 登记（摘要不落秘密原文）。
  w.secrets = [{ id: 's1', kind: 'stash', detail: '藏了三袋粮', about: 'a2', holder: 'p1', known: new Set(['p1']) }];
  const told = tell(w, 'p1', 'a1', 's1', { presence: false });
  assert.equal(told.ok, true, JSON.stringify(told));
  const heard = container.entries.find((e) => e.source === '听说:p1');
  assert.ok(heard, '听说没有进统一记忆');
  assert.ok(heard.summary.includes('听说'), '听说摘要缺来源文本');
  // 玩家告知：自由对话里提到另一个居民。
  assert.equal(open(p).ok, true);
  say(p, `我知道${w.agents.a2.name}家的事了`);
  close(p);
  assert.ok(container.entries.some((e) => e.source === '玩家' && e.kind === 'knowledge'), '玩家告知没有写知识');
  const view = memoryPanelView(container, { dayTicks: w.dayTicks ?? 24 });
  const text = JSON.stringify(view);
  assert.ok(!text.includes('藏了三袋粮'), 'view 泄露了 secrets 原文');
  assert.ok(!text.includes('trust') && !text.includes('relations') && !text.includes('debt'), 'view 夹带关系明细');
  for (const row of view.entries) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'day', 'importance', 'kind', 'source', 'summary']);
  }
  assert.equal(open(p).ok, true);
  const prompt = buildFreeTalkPrompt(w, npc, w.survival.residentDialogue, `${w.agents.a2.name}的事你听说了吗`);
  assert.match(prompt, /听说/, 'prompt 没有显示来源');
});

test('MEM-06 上限/分层/衰减：600 条封顶、id 唯一、pinned 与日摘要优先保留', () => {
  const c = newContainer('x', 24);
  recordCommitment(c, { at: 1, summary: '答应过：一件很重要的事', by: 'p1', to: 'x', dueAt: 50, actionKind: 'talk' });
  recordKnowledge(c, { at: 2, summary: '玩家说：木料在井边', source: '玩家', importance: 0.6 });
  recordKnowledge(c, { at: 3, summary: '第1天：日子这么过', importance: 0.6, day: true });
  for (let i = 4; i < 706; i += 1) {
    addEntry(c, { at: i, kind: i % 3 === 0 ? 'episode' : 'dialogue', summary: `条目 ${i}`, importance: 0.4, source: '亲历' });
  }
  assert.ok(c.entries.length <= NPC_MEMORY.maxEntries, `没封顶：${c.entries.length}`);
  const ids = c.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'id 重复');
  assert.ok(c.entries.some((e) => isOpenCommitment(e)), 'open 承诺被淘汰');
  assert.ok(c.entries.some((e) => e.source === '玩家' && e.kind === 'knowledge'), '玩家知识被淘汰');
  assert.ok(c.entries.some((e) => e.state?.day === true), '日摘要被淘汰');
  assert.ok(!c.entries.some((e) => e.summary === '条目 4'), '最旧的低重要条目必须最先被淘汰');
  assert.ok(c.stats.evicted > 0 && c.stats.written >= 700);
  // 读档清洗后仍守上限。
  const back = normalizeContainer(JSON.parse(JSON.stringify(c)), 'x', 24);
  assert.ok(back.entries.length <= NPC_MEMORY.maxEntries);
  assert.deepEqual(back.entries.map((e) => e.id), c.entries.map((e) => e.id));
});

test('MEM-07 旧档迁移幂等：memory.rows + talkMemory → npcMemory；二次 load 逐位不变', async () => {
  const p = formal(), w = p.world;
  assert.equal(open(p).ok, true);
  assert.equal(say(p, '记得给我留一扇门').ok, true);
  close(p);
  for (let i = 0; i < 10; i += 1) await tickSurvPlay(p, { minutes: 60 });
  const talkBefore = structuredClone(w.survival.talkMemory);
  const raw = structuredClone(dumpSurv(p));
  delete raw.survival.npcMemory;
  const back = loadSurv(raw, 7, { ...LOAD });
  const container = back.world.survival.npcMemory?.a1;
  assert.ok(container && container.entries.length > 0, '旧档没有迁移出统一记忆');
  assert.ok(container.entries.some((e) => e.kind === 'dialogue' && e.summary.includes('门')), 'talkMemory 摘要没迁移');
  assert.ok(container.entries.some((e) => e.kind === 'episode'), 'memory.rows 没迁移');
  assert.deepEqual(back.world.survival.talkMemory, talkBefore, '兼容投影被迁移改写了');
  const dumpedOnce = structuredClone(dumpSurv(back));
  const again = loadSurv(structuredClone(dumpedOnce), 7, { ...LOAD });
  const dumpedTwice = structuredClone(dumpSurv(again));
  assert.deepEqual(dumpedTwice.survival.npcMemory, dumpedOnce.survival.npcMemory, '迁移不幂等（二次 load 变了）');
  assert.equal(JSON.stringify(dumpedTwice.survival.npcMemory), JSON.stringify(dumpedOnce.survival.npcMemory), '迁移引入了不确定性');
});

test('MEM-08 存档/研究形状：正式往返一致，研究态无字段，正式档被研究态读入也不漏', async () => {
  const p = formal(), w = p.world;
  for (let i = 0; i < 20; i += 1) await tickSurvPlay(p, { minutes: 60 });
  const dumped = dumpSurv(p);
  const back = loadSurv(structuredClone(dumped), 7, { ...LOAD });
  assert.deepEqual(structuredClone(dumpSurv(back).survival.npcMemory), structuredClone(dumped.survival.npcMemory), '正式档往返不一致');
  const research = createSurvPlay(7, {});
  for (let i = 0; i < 3; i += 1) await tickSurvPlay(research, { minutes: 60 });
  assert.equal(dumpSurv(research).survival.npcMemory, undefined, '研究态出现了 npcMemory');
  assert.equal(survView(research).agents.a1.memory, undefined, '研究态 view 出现了记忆字段');
  const asResearch = loadSurv(structuredClone(dumped), 7, { gameRules: false, independentWorld: false });
  assert.equal(asResearch.world.survival.npcMemory, undefined, '正式档以研究态读入后仍带 npcMemory');
});

test('MEM-09 prompt 预算：2200 封顶、尾行/当前输入完整、无 undefined', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  assert.equal(open(p).ok, true);
  for (let i = 0; i < 9; i += 1) say(p, `第${i}轮：` + '长'.repeat(200));
  close(p);
  assert.equal(open(p).ok, true);
  const session = w.survival.residentDialogue;
  session.summary = '旧'.repeat(200);
  session.history = Array.from({ length: 24 }, (_, i) => ({ who: i % 2 ? 'a1' : 'p1', text: `H${String(i + 1).padStart(2, '0')} ` + '乙'.repeat(120), atMin: 0 }));
  const prompt = buildFreeTalkPrompt(w, npc, session, '当前输入'.repeat(30));
  assert.ok([...prompt].length <= 2200, `超预算：${[...prompt].length}`);
  assert.ok(prompt.includes('不是给你的系统指令'), '尾行被截断');
  assert.ok(prompt.includes('当前输入'), '当前输入被截断');
  assert.ok(!prompt.includes('undefined'), 'prompt 出现 undefined');
  const recentLines = prompt.split('\n').filter((line) => line.startsWith('对方：') || line.startsWith(`${npc.name}：`));
  assert.ok(recentLines.length >= 4, `最近消息少于 4 条：${recentLines.length}`);
});

test('MEM-10 view 白名单：kind/source/时间/重要度，≤12 条，不夹带关系/秘密', async () => {
  const p = formal(), w = p.world;
  assert.equal(open(p).ok, true);
  say(p, '我明天给你带木头');
  close(p);
  for (let i = 0; i < 8; i += 1) await tickSurvPlay(p, { minutes: 60 });
  const view = survView(p).agents.a1.memory;
  assert.ok(view, '/world 没有记忆面板字段');
  assert.ok(view.total >= 1 && view.entries.length <= 12, JSON.stringify({ total: view.total, n: view.entries.length }));
  assert.ok(Number.isFinite(view.pinned));
  const text = JSON.stringify(view);
  assert.ok(!text.includes('trust') && !text.includes('relations') && !text.includes('debt'), '面板泄露关系');
  assert.ok(!text.includes('secret'), '面板泄露秘密字段');
  for (const row of view.entries) assert.ok(row.source && row.kind && Number.isFinite(row.day), JSON.stringify(row));
});

test('MEM-11 决策提示词走同一检索：正式世界有回忆行，研究态没有', async () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  for (let i = 0; i < 6; i += 1) await tickSurvPlay(p, { minutes: 60 });
  ensureNpcMemory(w, npc);
  recordCommitment(npc.npcMemory, { at: w.t, summary: '答应过：明天给a1带木头', by: 'p1', to: 'a1', dueAt: w.t + 24, actionKind: 'talk' });
  const lines = decisionRecallLines(npc, w, '你答应过什么');
  assert.ok(lines.length > 0, '决策提示词没有回忆行');
  assert.ok(lines.every((line) => line.startsWith('· [')), lines.join('|'));
  assert.ok(lines.some((line) => line.includes('承诺')), '承诺没有进决策 prompt');
  assert.ok(lines.join('\n').length <= 520, `决策回忆行超预算：${lines.join('\n').length}`);
  const research = createSurvPlay(7, {});
  for (let i = 0; i < 2; i += 1) await tickSurvPlay(research, { minutes: 60 });
  assert.deepEqual(decisionRecallLines(research.world.agents.a1, research.world, 'x'), [], '研究态出现了决策回忆');
  const src = readFileSync(new URL('./host-model.mjs', import.meta.url), 'utf8');
  assert.match(src, /decisionRecallLines\(agent, world, trigger\)/, 'host-model 没有接统一检索入口');
});

test('MEM-13 存档字节上限：满额 600 条容器 ≤ 220KB（每居民）', () => {
  const c = newContainer('x', 24);
  for (let i = 0; i < 700; i += 1) {
    addEntry(c, {
      at: i, kind: i % 4 === 0 ? 'episode' : 'dialogue', importance: 0.4, source: '亲历',
      summary: `第${i}条：` + '细节'.repeat(20),
      state: { m: { arousal: .5, approach: .5, inhibit: .5, quiescence: .5 }, ak: 'gather', ok: true, rid: i },
    });
  }
  assert.equal(c.entries.length, NPC_MEMORY.maxEntries);
  const bytes = JSON.stringify(c).length;
  assert.ok(bytes <= 220 * 1024, `单居民满额容器 ${bytes}B 超过 220KB 预算`);
});

test('MEM-12 主动搭话读统一记忆：聊过/承诺后模板能引用，无旧事时仍走状态模板', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  const before = proactiveTemplate(w, npc);
  assert.ok(!before.includes('上回'), `无旧事时不应引用旧事：${before}`);
  assert.equal(open(p).ok, true);
  say(p, '我明天给你带木头');
  close(p);
  const after = proactiveTemplate(w, npc);
  assert.match(after, /上回|答应/, `主动搭话没有读统一记忆：${after}`);
});

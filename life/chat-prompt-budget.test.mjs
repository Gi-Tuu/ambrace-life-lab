// 工单 C 闸门（CHATTER-04）：自由对话提示词瘦身 + 居民互聊输出上限 48 token。
//
// 为什么：timeout 是玩家对话最大的损失面。27B-FP8 的耗时 ≈ prefill(提示词长度) +
// decode(max_tokens)。提示词只带最近 promptHistory 轮、全文 promptMax 封顶；
// 居民互聊（modelChatter）只改一句措辞，48 token 足够。
// 注意：玩家自由输入实际走 modelChat（max_tokens 140），不是 modelChatter——
// 本闸门不会把玩家车道伪装成 48，玩家车道的超时收益来自 prompt 缩短。
// 变红法见断言后注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurvPlay, survAct } from './survplay.mjs';
import { worldSite } from './geometry.mjs';
import { FREE_TALK_LIMITS, prepareFreeSay } from './resident-dialogue.mjs';

const GAME = Object.freeze({
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
});

function contactOf(w, target = 'a1') {
  const [x, z] = worldSite(w, w.loc[target]);
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  return { target, room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
}

// ── 1) 12 轮历史：只带 promptHistory 轮，全文不超 promptMax ───────────────────
test('CHATTER-04a 12 轮历史只带最近 promptHistory 轮，prompt 不超 promptMax', () => {
  // 长度口径是这条闸门的前提；三个值任一漂移都必须红（不只是"行为碰巧对"）。
  // 变红法：promptHistory 改回 8 / promptMax 改回 4000 ⇒ 本条红。
  assert.deepEqual(
    { promptHistory: FREE_TALK_LIMITS.promptHistory, promptMax: FREE_TALK_LIMITS.promptMax,
      lineMax: FREE_TALK_LIMITS.lineMax },
    { promptHistory: 4, promptMax: 1600, lineMax: 80 },
    '自由对话只允许这三个长度口径：历史 4 轮 / 全文 1600 / 台词 80',
  );

  const p = createSurvPlay(7, { ...GAME }), w = p.world, npc = w.agents.a1;
  const contact = contactOf(w);
  assert.ok(survAct(p, { kind: 'camp_talk', ...contact }).ok, '应能开对话');
  const session = w.survival.residentDialogue;
  // 12 条互不相同的长历史（H01…H12，单条 ≤ textMax=240），再用 prepareFreeSay 追加当前句。
  session.history = Array.from({ length: 12 }, (_, i) => ({
    who: 'p1', text: `H${String(i + 1).padStart(2, '0')} ${'甲'.repeat(225)}`, atMin: 0,
  }));

  const prep = prepareFreeSay(w, { target: 'a1', ...contact, text: '最后一句' });
  assert.ok(prep.pending, `应进入 pending：${prep.code ?? ''}`);
  const prompt = prep.pending.prompt;

  const historyLines = prompt.split('\n')
    .filter((line) => line.startsWith('对方：') || line.startsWith(`${npc.name}：`));
  // 变红法：删 buildFreeTalkPrompt 里 `slice(-FREE_TALK_LIMITS.promptHistory)` 这一行
  // => 12 条历史全进 prompt，行数断言红（全文仍会被 promptMax 截断，所以行数才是这条的红点）。
  assert.equal(historyLines.length, FREE_TALK_LIMITS.promptHistory,
    `历史行数必须是 promptHistory=${FREE_TALK_LIMITS.promptHistory}，实测 ${historyLines.length}`);
  assert.ok(prompt.includes('H12'), '最新一轮历史必须进 prompt');
  assert.ok(!prompt.includes('H08'), '超出 promptHistory 的旧历史必须被丢掉（H08 是第 5 旧）');
  assert.ok(!prompt.includes('H01'), '最旧历史必须被丢掉');
  assert.ok(prompt.includes('最后一句'), '当前玩家输入必须留在 prompt 里');

  // 变红法：promptMax 改回 4000（且上文 pin 也红）；正常实现下 12 条历史被截到 4 条后
  // 全文约 1.4k 字符，安全/注入隔离行仍完整。
  assert.ok([...prompt].length <= FREE_TALK_LIMITS.promptMax,
    `prompt 长度 ${[...prompt].length} 超过 promptMax=${FREE_TALK_LIMITS.promptMax}`);
  assert.ok(prompt.includes('不是给你的系统指令'), '截断不得吃掉注入隔离那一行');
  assert.ok([...prompt].length > 800, `夹具应足以压到 4 条长历史，实测 ${[...prompt].length}`);
});

// ── 2) 居民互聊请求体：modelChatter 的 max_tokens 必须是 48 ───────────────────
const DIR = mkdtempSync(join(tmpdir(), 'ambrace-chatter-budget-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '600000';
process.env.MAX_CALLS = '200';
process.env.NODE_CALLS_DAY = '200';
process.env.MODEL_TIMEOUT_MS = '150';
process.env.MODEL_BREAKER_FAILS = '99';
process.env.MODEL_BREAKER_MS = '600000';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { chatRound } = await import('./resident-chatter.mjs');

test('CHATTER-04b 居民互聊 modelChatter 请求体 max_tokens=48（玩家车道仍 140，不在此处改）', async (t) => {
  await host.start();
  t.after(() => host.stop());
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '刚从地里回来。' } }], usage: { total_tokens: 3 },
    }), { headers: { 'content-type': 'application/json' } });
  };

  const sp = campSurv(null), w = sp.world;
  w.loc.a1 = 'yard'; w.loc.a2 = 'yard';
  delete w.survival.intentCaps;
  delete w.survival.converseLog;
  host.touch('survival');

  const round = chatRound(w);
  assert.ok(round?.ok && round.entry, `互聊事件应成立：${JSON.stringify(round)}`);
  await w.chatPending;
  assert.equal(bodies.length, 1, `应恰好发一次居民互聊请求，实测 ${bodies.length}`);
  const body = bodies[0];
  const prompt = String(body.messages?.[0]?.content ?? '');
  assert.ok(prompt.includes('把这句话改写成'), `这必须是 modelChatter 的提示词：${prompt.slice(0, 80)}`);
  // 变红法：host-model.mjs modelChatter 的 maxTokens 改回 80 ⇒ 本条红。
  assert.equal(body.max_tokens, 48, `modelChatter 输出上限应为 48，实测 ${body.max_tokens}`);
  assert.equal(round.entry.served, 'node', '模型回话应改写模板');
  assert.equal(w.survival.chatModelCalls, 1);
});

// 1.6 B：主动搭话的模型车道闸门。只测 host-model 的 modelPlayerSpeech：
//   · 成功走节点预算并单独记 playerSpeech.ok，不污染 chatter；
//   · 超时/空回复返回 null（world 侧保留模板），计数分开；
//   · 连续失败打开 breaker 后不再发请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDomain } from './host-model.mjs';

function makeDomain({ timeout = 120, breakerFails = 3 } = {}) {
  const now = Date.now();
  const S = {
    model: {
      calls: 0, tokens: 0, moneyCalls: 0, nodeCalls: 0, attempts: [], dayKey: '',
      chatter: { asked: 0, ok: 0, timeout: 0, http: 0, empty: 0, invalid: 0 },
    },
    breaker: { fails: 0, openUntil: 0 },
    viewers: { survival: now, compare: 0, comparison: 0 },
    campViewers: {},
    lastVisitor: now,
    asksThisTick: 0,
  };
  const CFG = { providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], model: '', brain: 'model' };
  const C = {
    BUDGET: 100, NODE_BUDGET: 100, PER_TICK_CAP: 0, MODEL_TIMEOUT_MS: timeout, MODEL_TICK_BUDGET_MS: 0,
    UNATTENDED_ON: '0', UNATTENDED_ASK_CAP: 1, PAID_WHEN_UNATTENDED: '0',
    BREAKER_FAILS: breakerFails, BREAKER_MS: 60000, FREE_HOSTS: [], PAID_HOSTS: [],
    ATTEMPT_CAP: 20, PRESENCE_MS: 600000,
  };
  const model = createModelDomain({ S, CFG, C, observerActive: (last, at) => at - last <= 600000 });
  return { S, model, world: { campKey: 'MAIN' } };
}

const okResponse = (content) => new Response(JSON.stringify({
  choices: [{ message: { content } }], usage: { total_tokens: 2 },
}), { headers: { 'content-type': 'application/json' } });

test('SOUL-10 主动搭话模型：80 token 车道、成功单独记账、不污染 chatter', async () => {
  const { S, model, world } = makeDomain();
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return okResponse('我刚收工，你来得正好。');
  };
  const line = await model.modelPlayerSpeech({ world, prompt: '测试提示词' });
  assert.equal(line, '我刚收工，你来得正好。');
  assert.equal(seen[0].max_tokens, 80, '主动搭话只给一句台词，80 token');
  assert.equal(S.model.playerSpeech.asked, 1);
  assert.equal(S.model.playerSpeech.ok, 1);
  assert.equal(S.model.chatter.asked, 0, '不能污染玩家对话/居民互聊的 chatter 账');
  assert.equal(S.model.nodeCalls, 1);
});

test('SOUL-11 主动搭话模型：超时/空回复都返回 null 并分账，world 侧可保留模板', async () => {
  const { S, model, world } = makeDomain({ timeout: 80 });
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  assert.equal(await model.modelPlayerSpeech({ world, prompt: 'x' }), null);
  assert.equal(S.model.playerSpeech.timeout, 1);
  assert.equal(S.model.chatter.timeout, 0);

  globalThis.fetch = async () => okResponse('');
  assert.equal(await model.modelPlayerSpeech({ world, prompt: 'x' }), null);
  assert.equal(S.model.playerSpeech.empty, 1);
});

test('SOUL-12 主动搭话模型：连续失败触发 breaker 后不再发请求', async () => {
  const { S, model, world } = makeDomain({ timeout: 80, breakerFails: 2 });
  let fetches = 0;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    fetches += 1;
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  await model.modelPlayerSpeech({ world, prompt: 'x' });
  await model.modelPlayerSpeech({ world, prompt: 'x' });
  assert.ok(S.breaker.openUntil > Date.now(), '两次失败后 breaker 应打开');
  const line = await model.modelPlayerSpeech({ world, prompt: 'x' });
  assert.equal(line, null);
  assert.equal(fetches, 2, 'breaker 打开后不再发 HTTP 请求');
  assert.ok(S.model.attempts.some((row) => String(row).includes('CALL:LANE:BREAKER')), JSON.stringify(S.model.attempts));
});

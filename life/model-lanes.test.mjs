// N 组闸门：无人时的模型权限与"两把尺子"。
// 承诺只有一句：**没人看的时候，世界可以继续使用只花电的自有节点，但一分钱都不该花出去。**
// 这条承诺的全部逻辑都在 modelChannel 这一个纯函数里，所以它必须被逐格断言，而不是靠端到端碰运气。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-lanes-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.TICK_MS = '1000000';
process.env.MAX_CALLS = '50';            // 钱
process.env.NODE_CALLS_DAY = '6';        // 电
process.env.MAX_CALLS_PER_TICK = '1';
process.env.UNATTENDED_CALLS_PER_TICK = '1';
process.env.MODEL_TIMEOUT_MS = '300';
process.env.MODEL_TICK_BUDGET_MS = '0';
process.env.PRESENCE_MS = '600000';
process.env.MODEL_BREAKER_FAILS = '2';
process.env.MODEL_BREAKER_MS = '600000';
process.env.PAID_MODEL_HOSTS = 'localhost'; // 让两条路都指向回环但一个是"要花钱的"

const { host, modelChannel, isFreeProvider, breakerOpenAt } = await import('./host.mjs');
test.after(() => host.stop());

const NODE_URL = 'http://127.0.0.1:9/v1';   // 免费（回环）
const MONEY_URL = 'http://localhost:9/v1';  // 付费（PAID_MODEL_HOSTS 覆盖）

const hits = { node: 0, money: 0 };
let nodeMode = 'ok';
globalThis.fetch = async (url, opts = {}) => {
  const isNode = String(url).startsWith(NODE_URL);
  if (isNode) hits.node += 1; else hits.money += 1;
  const body = JSON.parse(opts.body ?? '{}');
  if (isNode && nodeMode !== 'ok') return { ok: false, status: 503, json: async () => ({}) };
  const text = body.messages?.[0]?.content ?? '';
  const id = /^- ([^\s|]+)/m.exec(text)?.[1] ?? 'rest';
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ id, reason: 'fake' }) } }], usage: { total_tokens: 3 } })
  };
};

const runUntil = async (pred, cap = 400) => {
  for (let i = 0; i < cap; i += 1) { if (pred()) return true; await host.tickOnce(); await new Promise((r) => setImmediate(r)); }
  throw new Error('等不到模型请求');
};

test('N1 分类：回环与白名单免费，PAID 覆盖优先', () => {
  assert.equal(isFreeProvider(NODE_URL), true);
  assert.equal(isFreeProvider('http://localhost:7860/brain/v1'), false, 'PAID_MODEL_HOSTS 必须能压过回环判定');
  assert.equal(isFreeProvider('https://api-inference.modelscope.cn/v1'), false);
  assert.equal(isFreeProvider('https://api.suanli.cn/v1'), false);
  assert.equal(isFreeProvider('not-a-url'), false);
});

test('N2 车道矩阵：无人禁付费、熔断只关免费路、两本账各管各', () => {
  const base = { moneyBudget: 50, nodeBudget: 6, breakerOpen: false, allowPaidUnattended: false };
  assert.deepEqual({ ...modelChannel({ ...base, watched: true, free: true }) }, { go: true, kind: 'node' });
  assert.deepEqual({ ...modelChannel({ ...base, watched: true, free: false }) }, { go: true, kind: 'money' });
  assert.deepEqual({ ...modelChannel({ ...base, watched: false, free: true }) }, { go: true, kind: 'node' }, '无人时仍可用节点：这是"世界自洽"的部分');
  assert.equal(modelChannel({ ...base, watched: false, free: false }).why, 'NO_OBSERVER', '无人时的付费路必须关');
  assert.equal(modelChannel({ ...base, watched: false, free: false, allowPaidUnattended: true }).go, true, '显式放开才允许无人付费');
  assert.equal(modelChannel({ ...base, watched: true, free: true, breakerOpen: true }).why, 'BREAKER');
  assert.equal(modelChannel({ ...base, watched: true, free: false, breakerOpen: true }).go, true, '熔断不该牵动付费路');
  assert.equal(modelChannel({ ...base, watched: true, free: false, moneyCalls: 50 }).why, 'BUDGET');
  assert.deepEqual({ ...modelChannel({ ...base, watched: true, free: true, moneyCalls: 50 }) }, { go: true, kind: 'node' }, '钱花完不能连带掐死只花电的链路');
  assert.equal(modelChannel({ ...base, watched: true, free: true, nodeCalls: 6 }).why, 'NODE_BUDGET');
  assert.equal(modelChannel({ ...base, watched: false, free: true, nodeCalls: 6 }).why, 'NODE_BUDGET');
  assert.equal(breakerOpenAt({ openUntil: 0 }), false);
  assert.equal(breakerOpenAt({ openUntil: Date.now() + 60000 }), true);
});

test('N3 无人运行：节点答活，付费端点一次都不许被碰到', async () => {
  hits.node = 0; hits.money = 0; nodeMode = 'ok';
  host.setBackend({ providers: [NODE_URL, MONEY_URL], keys: ['k', 'k'], model: '', models: ['m-node', 'm-money'], brain: 'model' });
  await host.start(); host.stop(); // start 会把 viewers 归零 ⇒ 之后就是"无人"状态
  await runUntil(() => hits.node > 0);
  for (let i = 0; i < 6; i += 1) await host.tickOnce();
  const st = host.status();
  assert.ok(hits.node >= 1, '无人时也应该问模型（游戏态默认开）');
  assert.equal(hits.money, 0, `无人时付费端点必须 0 次，实测 ${hits.money}`);
  assert.equal(st.moneyCalls ?? 0, 0, '付费账本必须为 0');
  assert.ok((st.nodeCalls ?? 0) >= 1, '免费账本要记上');
  assert.equal(st.unattended, true);
  assert.equal(st.paidWhenUnattended, false);
});

test('N4 中继坏了：熔断打开后停止白等，且无人时仍不花钱', async () => {
  hits.node = 0; hits.money = 0; nodeMode = 'fail';
  await host.start(); host.stop();
  // 询问是事件驱动的（不是每拍都问），所以轮到熔断真的打开为止，而不是赌一个固定拍数——
  // 赌拍数在负载下会先红后绿，那种"偶发"其实是我们自己写的假设错了。
  let spins = 0;
  while (!breakerOpenAt(host.status().breaker) && spins < 400) { await host.tickOnce(); spins += 1; }
  const st = host.status();
  assert.equal(st.breaker.open, true, `轮到 ${spins} 拍仍未熔断（节点被试 ${hits.node} 次）`);
  assert.ok(hits.node >= 2, `连续失败要喂给熔断，实测只试了 ${hits.node} 次`);
  assert.equal(hits.money, 0, '节点挂掉也不等于可以偷偷花钱');
  const before = hits.node;
  for (let i = 0; i < 8; i += 1) await host.tickOnce();
  assert.equal(hits.node, before, '熔断打开后不该每次询问都再白等一次');
  assert.ok(st.breaker.trips >= 1);
});

test('N5 有观众且节点仍坏：允许落到付费路，账记在钱上', async () => {
  hits.node = 0; hits.money = 0; nodeMode = 'fail';
  await host.start(); host.stop();
  for (let i = 0; i < 400 && hits.money === 0; i += 1) { host.touch('survival'); await host.tickOnce(); }
  const st = host.status();
  assert.ok(hits.money >= 1, `有观众时应当允许回退到付费端点，实测 ${hits.money}`);
  assert.ok((st.moneyCalls ?? 0) >= 1, '付费成功要记账，且记在钱这本上');
  assert.equal(st.watching, true);
});

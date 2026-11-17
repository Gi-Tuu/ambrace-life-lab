// DM-3′ 闸门：审议车道可以单独指一台引擎，但只能在"只花电的节点路"上生效。
// 立这条的理由是实测（docs/PLAN.md §87）：27B 审议 P95 8798ms 超引擎上限 4000ms ⇒ 抽样 38% 白烧；
// 同题的 32B P95 3190ms、超窗 1.7%。与规则层的一致率两家同档（40–50%），串行与并发下互有胜负，
// 所以换的是**尾部延迟**，不是"更聪明"。对话不在本单范围，必须继续留在主脑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-lane-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.TICK_MS = '1000000';
process.env.MAX_CALLS = '50';
process.env.NODE_CALLS_DAY = '600';
process.env.MAX_CALLS_PER_TICK = '1';
process.env.UNATTENDED_CALLS_PER_TICK = '1';
process.env.MODEL_TIMEOUT_MS = '30000';
process.env.MODEL_TICK_BUDGET_MS = '0';
process.env.PRESENCE_MS = '600000';
process.env.PAID_MODEL_HOSTS = 'localhost'; // 让两条路都指向回环，但其中一条算"要花钱的"

const { host } = await import('./host.mjs');
const { parseUpstreamMap, upstreamFor } = await import('../scripts/brain-agent.mjs');
test.after(() => host.stop());

const NODE_URL = 'http://127.0.0.1:9/v1';
const MONEY_URL = 'http://localhost:9/v1';

let bodies = { node: [], money: [] };
globalThis.fetch = async (url, opts = {}) => {
  const isNode = String(url).startsWith(NODE_URL);
  try { bodies[isNode ? 'node' : 'money'].push(JSON.parse(opts.body ?? '{}')); } catch { bodies.parseError = true; }
  const body = bodies[isNode ? 'node' : 'money'].at(-1) ?? {};
  const text = body.messages?.[0]?.content ?? '';
  const id = /^- ([^\s|]+)/m.exec(text)?.[1] ?? 'rest';
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ id, reason: 'fake' }) } }], usage: { total_tokens: 3 } })
  };
};

const untilCall = async (key, cap = 400) => {
  for (let i = 0; i < cap; i += 1) {
    if (bodies[key].length) return;
    await host.tickOnce();
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等不到 ${key} 车道的模型请求`);
};

const boot = async () => { await host.start(); host.stop(); }; // start 会把 viewers 归零 ⇒ 之后是"无人"状态

test('LANE-01 未配置 DELIBERATION_MODEL：请求体与今天逐字相同（默认行为一位不许动）', async () => {
  bodies = { node: [], money: [] };
  host.setBackend({ providers: [NODE_URL], keys: ['k'], model: '', models: ['m-node'], brain: 'model' });
  await boot();
  await untilCall('node');
  const b = bodies.node[0];
  assert.equal(b.model, 'm-node', '不设就是原来的名字');
  assert.equal(b.response_format.type, 'json_object');
  assert.equal(b.max_tokens, 100);
  assert.equal(b.messages[0].content.includes('只输出 JSON'), true, '审议提示词仍是同一份成品字符串');
});

test('LANE-02 配置后：节点车道改指备用引擎，提示词与温度一位不变【变红法：删掉 mdl 的车道判定】', async () => {
  bodies = { node: [], money: [] };
  host.setBackend({ providers: [NODE_URL], keys: ['k'], model: '', models: ['m-node'],
    deliberationModel: 'm-alt', brain: 'model' });
  await boot();
  await untilCall('node');
  const b = bodies.node[0];
  assert.equal(b.model, 'm-alt', '审议只在这条只花电的路上换引擎');
  assert.equal(b.temperature, 0.85, '换引擎不等于换采样');
  assert.equal(b.max_tokens, 100, '换引擎不等于顺手压解码长度（27B 实测压到 40 也不降超时率）');
});

test('LANE-03 付费车道绝不套用备用引擎名：那名字上游不认识，换了就是白烧一次 400', async () => {
  bodies = { node: [], money: [] };
  host.setBackend({ providers: [MONEY_URL], keys: ['k'], model: '', models: ['m-money'],
    deliberationModel: 'm-alt', brain: 'model' });
  await boot();
  host.touch('survival'); // 付费车道只在有人看时开放
  await untilCall('money');
  assert.equal(bodies.money[0].model, 'm-money', '付费路必须继续用 MODEL_NAMES 里那位');
});

test('LANE-04 显式传空串就是要关掉车道，不是"没传所以保留旧值"', async () => {
  bodies = { node: [], money: [] };
  host.setBackend({ providers: [NODE_URL], keys: ['k'], model: '', models: ['m-node'], deliberationModel: 'm-alt', brain: 'model' });
  host.setBackend({ providers: [NODE_URL], keys: ['k'], model: '', models: ['m-node'], deliberationModel: '', brain: 'model' });
  await boot();
  await untilCall('node');
  assert.equal(bodies.node[0].model, 'm-node', '清空后要回到默认上游的名字');
});

test('LANE-05 agent 侧分流是纯函数：畸形条目丢弃、未知模型回落默认上游', () => {
  const map = parseUpstreamMap('m-alt=http://127.0.0.1:9027/v1/; 坏条目; =http://x; m-two=http://127.0.0.1:9028/v1');
  assert.deepEqual(Object.keys(map), ['m-alt', 'm-two'], '没有名字或没有地址的条目不能进表');
  assert.equal(map['m-alt'], 'http://127.0.0.1:9027/v1', '尾斜杠要收掉，否则拼出 //chat/completions');
  assert.equal(upstreamFor('m-alt', 'http://127.0.0.1:9026/v1', map), 'http://127.0.0.1:9027/v1');
  assert.equal(upstreamFor('m-node', 'http://127.0.0.1:9026/v1', map), 'http://127.0.0.1:9026/v1', '不在表里的名字走默认上游');
  assert.equal(upstreamFor(undefined, 'http://127.0.0.1:9026/v1', map), 'http://127.0.0.1:9026/v1');
  assert.equal(upstreamFor('m-alt', 'http://127.0.0.1:9026/v1', {}), 'http://127.0.0.1:9026/v1', '没配 UPSTREAM_MAP 时逐位保持今天的行为');
  assert.deepEqual(parseUpstreamMap(''), {}, '不设就是单车道');
});

// ── #53 的时长账：耗时 ≈ 0.5s(预填) + 0.127s × 生成token（vLLM /metrics 实测，生产均值 30.9 token）──
// 这两条闸门钉住"让模型少写字"这一修法，以及"不许用 max_tokens 当油门"这一决定。
const FAKE_AGENT = {
  id: 'a1', name: '蓑', traits: { archetype: '孤僻' }, ch: {},
  bank: { summary: () => '警觉中、趋近中' },
  drives: { dominant: () => ({ label: '刺激', e: 0.04, urgency: 0.01 }) },
};
const FAKE_WORLD = {
  t: 40, loc: { a1: 'yard', a2: 'yard' }, occupancy: { yard: ['a1', 'a2'] },
  agents: { a2: { name: '绛' } }, survival: { store: 2, water: 0.85 }, pinv: { a1: { wood: 2, stone: 0 } },
};
const FAKE_SCORED = [
  { id: 'gather', u: 1.0, act: { label: '采集木石（木料）' } },
  { id: 'rest', u: 0.2, act: { label: '靠着歇一会儿' } },
];

test('LANE-06 审议提示词的形状：理由收到 6 字、说话字段仍在、返回的是一份成品字符串【变红法：把 6字 改回 14字，或删掉说话那行】', async () => {
  const { buildDeliberationPrompt } = await import('./host.mjs');
  const p = buildDeliberationPrompt({ agent: FAKE_AGENT, scored: FAKE_SCORED, world: FAKE_WORLD,
    memories: [{ kind: 'gather', sim: 1 }], trigger: '遭遇' });
  assert.equal(typeof p, 'string', '必须还是字符串，不能退回数组');
  assert.ok(p.includes('不超过6字'), '理由必须收到 6 字（时长账）');
  assert.equal(p.includes('14字'), false, '旧的 14 字口径不得复活');
  assert.ok(p.includes('不要复述选项'), '必须显式禁止复述选项');
  assert.ok(p.includes('"text" 不超过 28 字'), 'S2 说话字段不能被"提速"悄悄删掉');
  assert.ok(p.includes('- gather | 采集木石（木料） | 同档'), '候选行仍是唯一一份渲染');
});

test('LANE-07 max_tokens 仍是 100：截断会产出半截 JSON ⇒ 审议静默失败，它不是油门【变红法：把请求体里的 100 改成 24】', async () => {
  bodies = { node: [], money: [] };
  host.setBackend({ providers: [NODE_URL], keys: ['k'], model: '', models: ['m-node'], brain: 'model' });
  await boot();
  await untilCall('node');
  const b = bodies.node[0];
  assert.equal(b.max_tokens, 100, '审议解码上限保持 100，收紧只能靠提示词');
  assert.equal(b.response_format.type, 'json_object', '约束解码仍在：实测去掉它并不更快，还更不合法');
  assert.ok(String(b.messages[0].content).includes('不超过6字'), '线上审议必须真的用上收紧后的提示词');
});

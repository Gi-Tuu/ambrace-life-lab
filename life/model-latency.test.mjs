// D1/D2/D3：模型延迟基线、整拍等待上限、Qwen3.8/非 Qwen/不支持额外参数的适配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsNoThink, withNoThink, withoutNoThink } from './model-adapter.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-latency-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.TICK_MS = '1000000';
process.env.MAX_CALLS = '50';
process.env.MAX_CALLS_PER_TICK = '1';
process.env.MODEL_TIMEOUT_MS = '40';
process.env.MODEL_TICK_BUDGET_MS = '60';
process.env.PRESENCE_MS = '600000';

const { host } = await import('./host.mjs');
test.after(() => host.stop());

const fake = { mode: 'ok', delay: 0, calls: [], aborted: 0 };
function decisionId(body) {
  try {
    const text = JSON.parse(body).messages?.[0]?.content ?? '';
    return /^- ([^\s|]+)/m.exec(text)?.[1] ?? 'rest';
  } catch { return 'rest'; }
}
const json = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 3 } }) });
globalThis.fetch = async (_url, opts = {}) => {
  const body = opts.body ?? '{}';
  fake.calls.push(JSON.parse(body));
  if (fake.mode === 'reject-kwargs' && JSON.parse(body).chat_template_kwargs && fake.calls.filter((x) => x.chat_template_kwargs).length === 1) {
    return { ok: false, status: 400, json: async () => ({}) };
  }
  if (fake.mode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
  if (fake.mode === 'hang' || fake.delay) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, fake.mode === 'hang' ? 1e9 : fake.delay);
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); fake.aborted += 1; reject(new Error('aborted')); }, { once: true });
    });
  }
  return json(JSON.stringify({ id: decisionId(body), reason: 'fake' }));
};

host.setBackend({ providers: ['https://fake.invalid/v1'], keys: ['k'], model: 'Qwen/Qwen3.8-27B', models: [], brain: 'model' });
await host.start();
const runUntil = async (cond, max = 80) => {
  for (let i = 0; i < max && !cond(); i += 1) await host.tickOnce();
};
const t0Calls = () => host.snapshot().model.calls;

test('D1/D2 慢模型不拖死世界与玩家动作；整拍等待有上限', async () => {
  fake.mode = 'ok'; fake.delay = 0; fake.calls = [];
  host.touch('survival');
  await runUntil(() => t0Calls() > 0);
  assert.ok(t0Calls() > 0, '样本里应至少发生一次模型调用');

  fake.mode = 'hang'; fake.delay = 0; fake.calls = []; fake.aborted = 0;
  const c0 = t0Calls();
  host.touch('survival');
  const t0 = Date.now();
  await host.tickOnce();
  const tickMs = Date.now() - t0;
  assert.ok(tickMs < 500, `tick blocked ${tickMs}ms`);
  const a0 = Date.now();
  const r = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
  const actMs = Date.now() - a0;
  assert.equal(r.ok, true);
  assert.ok(actMs < 500, `act blocked ${actMs}ms`);
  assert.ok(host.snapshot().survival.t >= 1);
  assert.ok(t0Calls() >= c0, '账本不应倒退');
});

test('D2 供应商 500 记录 attempts，世界仍推进', async () => {
  fake.mode = 'fail'; fake.calls = [];
  host.touch('survival');
  const t0 = Date.now();
  for (let i = 0; i < 80; i += 1) {
    await host.tickOnce();
    if ((host.snapshot().model.attempts ?? []).some((a) => String(a).includes('500'))) break;
  }
  assert.ok(Date.now() - t0 < 5000);
  const st = host.snapshot();
  assert.ok((st.model.attempts ?? []).some((a) => String(a).includes('500')), JSON.stringify(st.model.attempts.slice(-4)));
  assert.ok(st.survival.t >= 1);
});

test('D3 Qwen3.8 带关思考参数；端点 400 时去掉参数重试；非 Qwen 不带', async () => {
  fake.mode = 'ok'; fake.delay = 0; fake.calls = [];
  host.setBackend({ providers: ['https://fake.invalid/v1'], keys: ['k'], model: 'Qwen/Qwen3.8-27B', models: [], brain: 'model' });
  host.touch('survival');
  await runUntil(() => fake.calls.length > 0);
  assert.ok(fake.calls.some((b) => b.chat_template_kwargs?.enable_thinking === false), 'Qwen3.8 应带 enable_thinking=false');

  fake.mode = 'reject-kwargs'; fake.calls = [];
  host.touch('survival');
  await runUntil(() => fake.calls.length >= 2);
  assert.ok(fake.calls.some((b) => b.chat_template_kwargs), '第一次应尝试带参数');
  assert.ok(fake.calls.some((b) => !b.chat_template_kwargs), '400 后应去掉参数重试');

  fake.mode = 'ok'; fake.calls = [];
  host.setBackend({ providers: ['https://fake.invalid/v1'], keys: ['k'], model: 'deepseek-v4.1-flash', models: [], brain: 'model' });
  host.touch('survival');
  await runUntil(() => fake.calls.length > 0);
  assert.ok(fake.calls.every((b) => !b.chat_template_kwargs), '非 Qwen 不应带额外参数');
});

test('D3 适配器覆盖命名变体与请求体剥离', () => {
  for (const m of ['Qwen/Qwen3.8-27B', 'qwen3.8-27b', 'qwen3.8-27b-fp8', 'QWEN3.8-27B']) assert.equal(needsNoThink(m), true, m);
  for (const m of ['Qwen/Qwen3-8B', 'deepseek-v4.1-flash', 'qwen2.5-32b']) assert.equal(needsNoThink(m), false, m);
  const b = withNoThink({ model: 'x' }, 'Qwen/Qwen3.8-27B');
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.equal('chat_template_kwargs' in withoutNoThink(b), false);
});

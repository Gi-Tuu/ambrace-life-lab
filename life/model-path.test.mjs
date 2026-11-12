// BRAIN=model 真实链路的**免费**回归闸门：用假 fetch 走真 modelBrain 代码，覆盖
// 预算闸门 / 在场闸门 / 账面一致 / 供应商失败 / 坏 JSON 退替身 / H-04 预扣与退回。
// 这套路径在此前零覆盖（第二次审计 G1/BUG-10）：全部 37 个测试文件里没有一处 brain:'model'。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-model-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.TICK_MS = '10000000';
process.env.MAX_CALLS = '30';
process.env.PRESENCE_MS = '600000';

const { host, modelGate, modelRelease } = await import('./host.mjs');

// ── 假上游：行为可切换，调用次数可数 ────────────────────────────────────────
const fake = { calls: 0, mode: 'ok' };
globalThis.fetch = async (url, opts) => {
  fake.calls += 1;
  if (fake.mode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
  if (fake.mode === 'badjson') return { ok: true, json: async () => ({ choices: [{ message: { content: '这不是 JSON' } }], usage: { total_tokens: 7 } }) };
  // ok：从提示词的候选清单里挑第一个 id 原样回，模拟"模型照抄合法 id"
  let id = 'rest';
  try {
    const body = JSON.parse(opts.body);
    const text = String(body.messages?.[0]?.content ?? '');
    const m = text.match(/^- ([^\s|]+)/m);
    if (m) id = m[1];
  } catch { /* 保守回 rest */ }
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ id, reason: '假上游' }) } }], usage: { total_tokens: 11 } }) };
};

host.setBackend({ providers: ['https://fake.invalid/v1'], keys: ['k'], model: 'fake-model', models: [], brain: 'model' });
await host.start();
host.stop();

const snap = () => host.snapshot();
const sumCounter = (k) => ['A', 'B'].reduce((s, side) => s + Object.values(snap()[side].agents).reduce((t, a) => t + (a.counters[k] ?? 0), 0), 0)
  + Object.values(snap().survival?.agents ?? {}).reduce((t, a) => t + (a.counters?.[k] ?? 0), 0);
const runTicks = async (n, { touch = false } = {}) => {
  for (let i = 0; i < n; i += 1) {
    if (touch) host.touch();
    await host.tickOnce();
  }
};

test('M1 无人观看 ⇒ 一次上游调用都不许发（省额度设计）', async () => {
  fake.calls = 0;
  fake.mode = 'ok';
  const before = snap().model.calls;
  await runTicks(15, { touch: false }); // 不 touch
  assert.equal(fake.calls, 0, `无人观看仍发了 ${fake.calls} 次上游请求 ⇒ 额度白烧`);
  assert.equal(snap().model.calls, before, '账面也动了 ⇒ 闸门位置不对');
  assert.ok(sumCounter('skipped') > 0, '没有任何"被跳过"读数 ⇒ 事件门控没在跑，这条闸门是空跑');
});

test('M2 有观众 ⇒ 真的调用，且账面与上游调用数一致', async () => {
  fake.calls = 0;
  fake.mode = 'ok';
  const c0 = snap().model.calls;
  const t0 = snap().model.tokens;
  host.touch();
  for (let i = 0; i < 40 && snap().model.calls - c0 < 3; i += 1) await runTicks(1, { touch: true });
  const charged = snap().model.calls - c0;
  assert.ok(charged > 0, '有观众却一次都没调用 ⇒ 真模型链路没接上');
  assert.equal(fake.calls, charged, `账面 ${charged} 次 vs 上游 ${fake.calls} 次 ⇒ 记账与真实调用不一致`);
  assert.ok(snap().model.tokens > t0, 'token 没有累加');
  // 注意：一拍最多能发 8 次调用（3 个角色 × 2 侧 + 驳回重问），所以账面会一次跳多格；\n  // fallback 不在这里断言（预算触顶时 modelBrain 返回 null 也会计 fallback，那是正常退替身）。
  assert.equal(snap().A.t, snap().B.t, 'A/B 刻数错位');
});

test('M3 上游返回坏 JSON ⇒ 退替身且不崩，fallback 计数上升', async () => {
  fake.mode = 'badjson';
  const fb0 = sumCounter('fallback');
  const c0 = snap().model.calls;
  const t0 = snap().A.t;
  host.touch();
  for (let i = 0; i < 40 && snap().model.calls - c0 < 1; i += 1) await runTicks(1, { touch: true });
  assert.ok(snap().model.calls > c0, '没有发生调用，样本不足');
  assert.ok(snap().A.t > t0, '世界没有推进 ⇒ 坏 JSON 把 tick 打断了');
  assert.ok(sumCounter('fallback') > fb0, '坏 JSON 之后没有 fallback 计数 ⇒ 退替身路径没被走到');
  assert.equal(snap().A.t, snap().B.t);
  fake.mode = 'ok';
});

test('M4 供应商 500 ⇒ 记录 attempts、退回替身、账面不多记', async () => {
  fake.mode = 'fail';
  const c0 = snap().model.calls;
  const tk0 = snap().model.tokens;
  const t0 = snap().A.t;
  host.touch();
  const a0 = (snap().model.attempts ?? []).length;
  for (let i = 0; i < 80 && (snap().model.attempts ?? []).length === a0; i += 1) await runTicks(1, { touch: true });
  const st = snap();
  assert.ok(st.A.t > t0, `上游全失败把世界弄停了 calls=${st.model.calls} attempts=${JSON.stringify(st.model.attempts.slice(-2))}`);
  assert.ok((st.model.attempts ?? []).length > 0, `失败尝试没有进 attempts（运维看不到原因） calls=${st.model.calls}`);
  assert.ok(String(st.model.attempts.at(-1)).includes('500'), `attempts 里没有 HTTP 500：${JSON.stringify(st.model.attempts.slice(-2))} calls=${st.model.calls} budget=${st.model.budget}`);
  assert.equal(st.model.calls, c0, '失败的调用仍然记了账 ⇒ 额度被白吃');
  assert.equal(st.model.tokens, tk0, '失败的调用仍然累加了 token');
  fake.mode = 'ok';
});

test('M5 预算用尽 ⇒ 不再调用（熔断生效）', async () => {
  fake.mode = 'ok';
  host.touch();
  for (let i = 0; i < 400 && snap().model.calls < 30; i += 1) await runTicks(1, { touch: true });
  assert.equal(snap().model.calls, 30, `账面 ${snap().model.calls} ≠ MAX_CALLS 30`);
  const c0 = fake.calls;
  await runTicks(25, { touch: true });
  assert.equal(fake.calls, c0, `额度用尽后仍发了 ${fake.calls - c0} 次请求 ⇒ 熔断失效`);
  assert.equal(snap().model.budget, 30, '载荷里的 budget 与配置不一致');
});

test('M6 H-04 预扣与退回：并发也不可能超发', async () => {
  fake.mode = 'ok';
  // 额度已用尽（M5 之后 calls=30=MAX）⇒ gate 必须直接拒
  assert.equal(modelGate(), 'BUDGET');
  // 退回两次 ⇒ 额度回到 4，可以再放行两次，第三次又被拒
  modelRelease();
  modelRelease();
  assert.equal(snap().model.calls, 28);
  assert.equal(modelGate(), null, '退回后仍不放行');
  assert.equal(snap().model.calls, 29, '放行时没有预扣 ⇒ 并发下会超发');
  assert.equal(modelGate(), null);
  assert.equal(snap().model.calls, 30);
  assert.equal(modelGate(), 'BUDGET');
  // 预扣的额度在成功结算后不能被重复计
  const before = snap().model.calls;
  modelRelease();
  assert.equal(snap().model.calls, before - 1);
});

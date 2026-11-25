// 独立模型测试入口：默认关闭、令牌必查、限流/并发/长度/模型边界、真实中继往返。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { bootAudit5, stopAudit5 } from './audit5-harness.mjs';

const BODY = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: '你好' }], max_tokens: 40 };
const post = (base, body, token, path = '/test/v1/chat/completions') => {
  const url = new URL(path, base);
  if (token !== undefined) url.searchParams.set('test_token', token);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify(body ?? {}),
  });
};
const claim = async (base, token) => {
  for (let i = 0; i < 100; i += 1) {
    const r = await post(base, {}, token, '/brain/claim?relay_token=' + encodeURIComponent(token));
    if (r.status === 200) return r.json();
    if (r.status !== 204) throw new Error(`claim 异常 ${r.status}: ${await r.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('claim 超时');
};
const complete = (base, token, id, content = '测试回复') => post(base, {
  id, content, usage: { total_tokens: 7 }, finish_reason: 'stop',
}, token, '/brain/result?relay_token=' + encodeURIComponent(token));
const roundTrip = async (base, token, body = BODY) => {
  const waiter = post(base, body, token);
  const job = await claim(base, token);
  assert.equal((await complete(base, token, job.id)).status, 200);
  const res = await waiter;
  return { res, json: await res.json(), job };
};
const waitInFlight = async (base, want) => {
  for (let i = 0; i < 100; i += 1) {
    const j = await (await fetch(base + '/healthz')).json();
    if (j.relay?.test?.inFlight === want) return j;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`inFlight 未到 ${want}`);
};

test('MODELTEST-01 默认关闭；启用后缺令牌/错令牌 401，响应不回显令牌', async () => {
  const off = await bootAudit5({ BRAIN_RELAY_TOKEN: 'tok-off', MODEL_TEST_ENABLED: '0' });
  try {
    const r = await post(off.base, BODY, 'tok-off');
    assert.equal(r.status, 404, '未启用必须 404');
    assert.ok(!(await r.text()).includes('tok-off'));
  } finally { await stopAudit5(off); }

  const on = await bootAudit5({ BRAIN_RELAY_TOKEN: 'tok-on', MODEL_TEST_ENABLED: '1' });
  try {
    assert.equal((await post(on.base, BODY, undefined)).status, 401);
    const wrong = await post(on.base, BODY, 'wrong');
    assert.equal(wrong.status, 401);
    assert.ok(!(await wrong.text()).includes('wrong'));
  } finally { await stopAudit5(on); }
});

test('MODELTEST-02 查询参数令牌可走通 OpenAI 兼容往返，模型由服务端固定', async () => {
  const h = await bootAudit5({ BRAIN_RELAY_TOKEN: 'tok-round', MODEL_TEST_ENABLED: '1' });
  try {
    const { res, json, job } = await roundTrip(h.base, 'tok-round', {
      messages: [{ role: 'user', content: '你好' }], max_tokens: 40,
    });
    assert.equal(res.status, 200);
    assert.equal(job.body.model, 'qwen3.8-27b');
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.content, '测试回复');
    assert.equal(json.usage.total_tokens, 7);
    const health = await (await fetch(h.base + '/healthz')).json();
    assert.equal(health.relay.test.enabled, true);
    assert.equal(health.relay.test.maxTokens, 512);
    assert.equal(health.relay.test.maxBytes, 16384);
  } finally { await stopAudit5(h); }
});

test('MODELTEST-03 每分钟 6 次：容量 2、几乎不回水，第三次 429', async () => {
  const h = await bootAudit5({
    BRAIN_RELAY_TOKEN: 'tok-rate', MODEL_TEST_ENABLED: '1',
    MODEL_TEST_RATE_CAPACITY: '2', MODEL_TEST_RATE_REFILL_MS: '600000',
  });
  try {
    assert.equal((await roundTrip(h.base, 'tok-rate')).res.status, 200);
    assert.equal((await roundTrip(h.base, 'tok-rate')).res.status, 200);
    const limited = await post(h.base, BODY, 'tok-rate');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'RATE_LIMITED');
  } finally { await stopAudit5(h); }
});

test('MODELTEST-04 请求体 16KB、max_tokens 512、模型白名单、非流式边界', async () => {
  const h = await bootAudit5({ BRAIN_RELAY_TOKEN: 'tok-limits', MODEL_TEST_ENABLED: '1' });
  try {
    const huge = await post(h.base, { ...BODY, messages: [{ role: 'user', content: 'x'.repeat(17 * 1024) }] }, 'tok-limits');
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, 'BODY_TOO_LARGE');

    const tokens = await post(h.base, { ...BODY, max_tokens: 513 }, 'tok-limits');
    assert.equal(tokens.status, 400);
    assert.deepEqual(await tokens.json(), { error: 'BAD_MAX_TOKENS', max: 512 });

    const model = await post(h.base, { ...BODY, model: 'other-model' }, 'tok-limits');
    assert.equal(model.status, 400);
    assert.equal((await model.json()).error, 'MODEL_NOT_ALLOWED');

    const stream = await post(h.base, { ...BODY, stream: true }, 'tok-limits');
    assert.equal(stream.status, 400);
    assert.equal((await stream.json()).error, 'STREAM_UNSUPPORTED');
  } finally { await stopAudit5(h); }
});

test('MODELTEST-05 最多 2 个在途：第三个 TEST_BUSY，不占游戏队列第三格', async () => {
  const h = await bootAudit5({
    BRAIN_RELAY_TOKEN: 'tok-flight', MODEL_TEST_ENABLED: '1',
    MODEL_TEST_RATE_CAPACITY: '10', MODEL_TEST_RATE_REFILL_MS: '600000',
  });
  try {
    const a = post(h.base, BODY, 'tok-flight');
    const b = post(h.base, BODY, 'tok-flight');
    await waitInFlight(h.base, 2);
    const c = await post(h.base, BODY, 'tok-flight');
    assert.equal(c.status, 429);
    assert.equal((await c.json()).error, 'TEST_BUSY');
    const jobs = [await claim(h.base, 'tok-flight'), await claim(h.base, 'tok-flight')];
    for (const job of jobs) await complete(h.base, 'tok-flight', job.id);
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    await waitInFlight(h.base, 0);
  } finally { await stopAudit5(h); }
});

test('MODELTEST-06 CLI 只从环境变量取令牌，带浏览器 UA、不带 Authorization，输出不回显令牌', async () => {
  let seen = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = {
      token: new URL(req.url, 'http://local').searchParams.get('test_token'),
      ua: req.headers['user-agent'], auth: req.headers.authorization ?? null,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'CLI 回复' } }], usage: { total_tokens: 3 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/test/v1`;
  try {
    const child = spawn(process.execPath, ['scripts/model-test.mjs', '--base', base, '--json', '你好'], {
      cwd: process.cwd(), env: { ...process.env, AMBRACE_TEST_TOKEN: 'cli-secret' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, err);
    assert.equal(seen.token, 'cli-secret');
    assert.match(seen.ua, /Mozilla/);
    assert.equal(seen.auth, null);
    assert.equal(seen.body.model, 'qwen3.8-27b');
    assert.match(out, /CLI 回复/);
    assert.ok(!out.includes('cli-secret') && !err.includes('cli-secret'), 'CLI 输出不得回显令牌');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

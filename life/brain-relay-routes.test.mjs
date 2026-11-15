// 大脑中继的**路由面**闸门：这条路的威胁模型是"一个能被公网访问的端点，会把推理请求转嫁给云节点"，
// 所以默认关闭、令牌必查、队列满要立刻失败、超时要让引擎有机会走回退——四条都得能变红。
// 变红法：把 serve.mjs 里 `if (!RELAY_TOKEN) return json(res, 404 …)` 或 `relayAuthorized` 删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

async function boot(env = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await bootOnce(env); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function bootOnce(env) {
  const port = 18000 + Math.floor(Math.random() * 900);
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-relay-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        SEED_FILE: join(dir, 'no-seed.json'),
        BRAIN: 'local',
        MODEL_PROVIDERS: '',
        MODEL_BASE_URL: '',
        MODEL_KEYS: '',
        MODEL_KEY: '',
        MODEL_NAME: '',
        CHAT_TOKEN: '',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error(`服务器 15s 内没起来：${out}`)); }, 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes('就绪')) finish(resolve, { child, base: `http://127.0.0.1:${port}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(reject, new Error(`服务器提前退出 ${code}：${out}`)));
  });
}

const stop = (child) => new Promise((r) => { child.kill(); setTimeout(r, 400); });
const post = (base, path, body, token) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body ?? {})
});
const ENGINE_BODY = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: '今天做了什么' }], max_tokens: 40 };

test('R5 未配令牌时整组端点 404；配了令牌则无令牌 401', async () => {
  const off = await boot({ BRAIN_RELAY_TOKEN: '' });
  try {
    for (const p of ['/brain/claim', '/brain/result', '/brain/v1/chat/completions']) {
      assert.equal((await post(off.base, p, ENGINE_BODY, 'whatever')).status, 404, `${p} 未配置却应答，等于默认开放`);
    }
  } finally { await stop(off.child); }

  const on = await boot({ BRAIN_RELAY_TOKEN: 'tok-r5' });
  try {
    assert.equal((await post(on.base, '/brain/claim', {}, undefined)).status, 401, '缺令牌必须拒');
    assert.equal((await post(on.base, '/brain/claim', {}, 'tok-wrong')).status, 401, '错令牌必须拒');
    assert.equal((await post(on.base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-wrong')).status, 401);
  } finally { await stop(on.child); }
});

test('R6 引擎请求→排队→agent 取活交回：响应是 host.postChat 读得懂的形状', async () => {
  const { child, base } = await boot({ BRAIN_RELAY_TOKEN: 'tok-r6' });
  try {
    const waiter = post(base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-r6');
    await new Promise((r) => setTimeout(r, 120));
    const got = await (await post(base, '/brain/claim', {}, 'tok-r6')).json();
    assert.equal(got.body.model, 'qwen3.8-27b', '请求体必须原样送到 agent，中继层不解释内容');
    assert.equal((await post(base, '/brain/claim', {}, 'tok-r6')).status, 204, '一次投递：同一条活不能被取两次');
    assert.equal((await post(base, '/brain/result', { id: got.id, content: '{"id":13,"reason":"饿"}', usage: { total_tokens: 21 }, finish_reason: 'stop' }, 'tok-r6')).status, 200);

    const res = await waiter;
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.choices?.[0]?.message?.content, '{"id":13,"reason":"饿"}');
    assert.equal(j.usage?.total_tokens, 21, 'token 用量要透传，否则预算计数会失真');
    const st = await (await fetch(`${base}/healthz`)).json();
    assert.equal(st.relay.served, 1, 'healthz 必须看得见中继计数（现场排查靠它）');
  } finally { await stop(child); }
});

test('R7 无人取活则按超时收场；队列满则立刻 503，不堆积', async () => {
  const slow = await boot({ BRAIN_RELAY_TOKEN: 'tok-r7', BRAIN_RELAY_TTL_MS: '200' });
  try {
    const r = await post(slow.base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-r7');
    assert.equal(r.status, 504, '没有 agent ⇒ 必须 504，让引擎的供应商循环落到回退位');
    assert.equal((await r.json()).error, 'RELAY_TIMEOUT');
  } finally { await stop(slow.child); }

  const tiny = await boot({ BRAIN_RELAY_TOKEN: 'tok-r7b', BRAIN_RELAY_PENDING: '1' });
  try {
    const a = post(tiny.base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-r7b');
    await new Promise((r) => setTimeout(r, 120));
    const b = await post(tiny.base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-r7b');
    assert.equal(b.status, 503, '队列满 ⇒ 立刻失败，不许排第二个人');
    assert.equal((await b.json()).error, 'RELAY_BUSY');
    const got = await (await post(tiny.base, '/brain/claim', {}, 'tok-r7b')).json();
    await post(tiny.base, '/brain/result', { id: got.id, content: 'ok' }, 'tok-r7b');
    assert.equal((await a).status, 200);
  } finally { await stop(tiny.child); }
});

test('R8 迟到的结果被拒（409），不会把答案塞给已走开的等待方', async () => {
  const { child, base } = await boot({ BRAIN_RELAY_TOKEN: 'tok-r8', BRAIN_RELAY_TTL_MS: '150' });
  try {
    const waiter = post(base, '/brain/v1/chat/completions', ENGINE_BODY, 'tok-r8');
    await new Promise((r) => setTimeout(r, 60));
    const got = await (await post(base, '/brain/claim', {}, 'tok-r8')).json();
    await new Promise((r) => setTimeout(r, 260)); // 等超时先结算
    assert.equal((await waiter).status, 504);
    assert.equal((await post(base, '/brain/result', { id: got.id, content: '太晚了' }, 'tok-r8')).status, 409);
    const st = await (await fetch(`${base}/healthz`)).json();
    assert.deepEqual({ expired: st.relay.expired, late: st.relay.late, served: st.relay.served }, { expired: 1, late: 1, served: 0 });
  } finally { await stop(child); }
});

test('R9 BRAIN_RELAY_TOKEN=@model-key 时认容器自己的模型密钥（密文变量插不进新令牌）', async () => {
  const { child, base } = await boot({ BRAIN_RELAY_TOKEN: '@model-key', MODEL_KEYS: 'k-model-only' });
  try {
    assert.equal((await post(base, '/brain/claim', {}, 'k-other')).status, 401, '别的令牌必须拒');
    const waiter = post(base, '/brain/v1/chat/completions', ENGINE_BODY, 'k-model-only');
    await new Promise((r) => setTimeout(r, 120));
    const got = await (await post(base, '/brain/claim', {}, 'k-model-only')).json();
    assert.equal((await post(base, '/brain/result', { id: got.id, content: '好' }, 'k-model-only')).status, 200);
    assert.equal((await waiter).status, 200, '@model-key 必须能走完整条链');
  } finally { await stop(child); }

  const off = await boot({ BRAIN_RELAY_TOKEN: '@model-key', MODEL_KEYS: '' });
  try {
    assert.equal((await post(off.base, '/brain/claim', {}, 'anything')).status, 404, '无可比对密钥时仍默认关闭');
  } finally { await stop(off.child); }
});

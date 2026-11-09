// 2026-11-09 服务面加固闸门（AUDIT 的 BUG-8 /chat 开放代理、BUG-19 静态面暴露仓库文件）。
// 这两条只能在真 HTTP 面上验，所以这里 spawn 一个 serve.mjs 子进程打真实请求。
// 纪律：每条都必须能变红 —— 把 serve.mjs 的修复撤掉必须红（撤法见 test 名）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const ROOT = process.cwd();

// 端口随机 18000–18899：并发/残留连接时可能撞车。撞了就换一个端口重试，
// 不允许偶发 EADDRINUSE 把闸门吹成 flaky（这正是这份测试自己要防的那类问题）。
async function bootServer(env = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await bootServerOnce(env); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function bootServerOnce(env = {}) {
  const port = 18000 + Math.floor(Math.random() * 900);
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-serve-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dir,
        SEED_FILE: join(dir, 'no-seed.json'), // hermetic：不吃仓库里的演示种子
        BRAIN: 'local',
        MODEL_PROVIDERS: '',
        MODEL_BASE_URL: '',
        MODEL_KEYS: '',
        MODEL_KEY: '',
        MODEL_NAME: '',
        CHAT_TOKEN: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error(`服务器 15s 内没起来：${out}`)); }, 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes('就绪')) finish(resolve, { child, port, base: `http://127.0.0.1:${port}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(reject, new Error(`服务器提前退出 ${code}：${out}`)));
  });
}

async function stopServer(child) {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}

const get = (base, path) => fetch(`${base}${path}`, { redirect: 'manual' });
const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

// ─────────────────────────── BUG-19：静态面白名单 ───────────────────────────

test('BUG-19 静态面只放行 web/，仓库内部文件不可读 【变红法：把 serveStatic 改回黑名单 + startsWith(ROOT)】', async () => {
  const { child, base } = await bootServer();
  try {
    // 正控：页面与前端资源必须照常可读（否则等于把站点锁死）
    for (const p of ['/', '/index.html', '/web/app.js', '/web/index.html', '/web/assets/manifest.json']) {
      const r = await get(base, p);
      assert.equal(r.status, 200, `${p} 返回 ${r.status}，静态面被锁过头了`);
    }
    // 负控：仓库内部文件、大小写变体、编码穿越、路径穿越全部不可读
    const blocked = [
      '/.git/config',
      '/.git/HEAD',
      '/docs/PLAN.md',
      '/docs/AUDIT-2026-11-09.md',
      '/.env',
      '/.ENV',
      '/Data/world.json',
      '/data/world.json',
      '/contest.txt',
      '/serve.mjs',
      '/life/host.mjs',
      '/seed/world.json',
      '/web/../.git/config',
      '/web/%2e%2e%2f.git%2fconfig',
      '/WEB/app.js',
    ];
    for (const p of blocked) {
      const r = await get(base, p);
      assert.ok(r.status === 403 || r.status === 404, `${p} 竟然返回 ${r.status}（可读 ⇒ 仓库文件暴露）`);
      const text = await r.text();
      assert.ok(!text.includes('ref: refs/') && !text.includes('MODEL_KEY'), `${p} 泄漏了真实内容`);
    }
  } finally {
    await stopServer(child);
  }
});

// ─────────────────────────── BUG-8：/chat 默认关闭 ───────────────────────────

test('BUG-8 未配 CHAT_TOKEN 时 /chat 必须整个端点不存在 【变红法：把路由里的 if (!CHAT_TOKEN) return 404 撤掉】', async () => {
  const { child, base } = await bootServer();
  try {
    const r = await post(base, '/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 404, `/chat 在未配置令牌时返回 ${r.status} ⇒ 默认开放`);
    const r2 = await post(base, '/chat', { messages: [] }, { authorization: 'Bearer anything' });
    assert.equal(r2.status, 404);
  } finally {
    await stopServer(child);
  }
});

test('BUG-8 /chat 必须有鉴权，且不能靠它把 watching 顶成 true 【变红法：撤掉 chatAuthorized 与 touch 列表移除】', async () => {
  const { child, base } = await bootServer({ CHAT_TOKEN: 'smoke-test-token' });
  try {
    const noAuth = await post(base, '/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(noAuth.status, 401, `无令牌返回 ${noAuth.status}`);
    const wrong = await post(base, '/chat', { messages: [] }, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401, `错令牌返回 ${wrong.status}`);

    // /chat 不能算"有观众"：否则攻击者一边烧额度一边让世界继续调模型
    const hz = await (await get(base, '/healthz')).json();
    assert.equal(hz.world.watching, false, '/chat 把 watching 顶成了 true ⇒ 额度闸门被旁路');

    // 正令牌：没有观众 ⇒ 走 503 NO_OBSERVER，且不得到上游
    const ok = await post(base, '/chat', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer smoke-test-token' });
    assert.equal(ok.status, 503, `正令牌 + 无观众 返回 ${ok.status}`);
    const body = await ok.json();
    assert.equal(body.error, 'NO_OBSERVER', `拒因是 ${body.error}（应为 NO_OBSERVER）`);
    assert.equal(body.via, undefined, '响应里仍然回了端点明文 via');
    assert.equal(body.attempts, undefined, '响应里仍然回了尝试明细 attempts');
  } finally {
    await stopServer(child);
  }
});

test('BUG-8 额度耗尽时 /chat 必须被同一本账挡住 【变红法：把路由里的 modelGate() 判空撤掉】', async () => {
  const { child, base } = await bootServer({ CHAT_TOKEN: 'smoke-test-token', MAX_CALLS: '0' });
  try {
    await get(base, '/'); // 制造"有观众"，把 503/NO_OBSERVER 这条分支排除掉
    const r = await post(base, '/chat', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer smoke-test-token' });
    assert.equal(r.status, 429, `额度为 0 时返回 ${r.status}（应为 429 ⇒ 与 modelBrain 同一本账）`);
    const body = await r.json();
    assert.equal(body.error, 'BUDGET');
  } finally {
    await stopServer(child);
  }
});

// ═══════════════════ 第二次审计的修复闸门（2026-11-09 第二批）═══════════════════

test('H-01 一条畸形请求不得打死进程 【变红法：把 new URL 移回 try 之外】', async () => {
  const { child, base } = await bootServer();
  try {
    // 原始 socket 发一条非法 URL 的请求行：new URL('http://[', base) 会抛 ERR_INVALID_URL
    await new Promise((res) => {
      const sock = net.connect(new URL(base).port, '127.0.0.1', () => {
        sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
        setTimeout(() => { sock.destroy(); res(); }, 500);
      });
      sock.on('error', () => res());
    });
    await new Promise((r) => setTimeout(r, 400));
    // 进程必须还活着，且还能正常服务
    assert.equal(child.exitCode, null, `畸形请求把进程打死了（exit=${child.exitCode}）`);
    const hz = await (await get(base, '/healthz')).json();
    assert.equal(hz.ok, true, '畸形请求之后健康检查不再正常');
  } finally { await stopServer(child); }
});

test('H-02 CSRF：text/plain 与跨站请求必须被挡住 【变红法：删掉 mutatingDenied 的 content-type / sameOrigin 检查】', async () => {
  const { child, base } = await bootServer();
  try {
    // 先用正常 JSON 推进几刻，制造可观测的 t
    await post(base, '/ctl', { action: 'step' });
    const t0 = (await (await get(base, '/world')).json()).A.t;
    assert.ok(t0 > 0, '没有推进，测试无样本');

    // (a) text/plain：CORS "simple request"，浏览器不预检 ⇒ 这是真实的 CSRF 形态
    const plain = await fetch(`${base}/ctl`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'reset', confirm: true }) });
    assert.equal(plain.status, 403, `text/plain 的 reset 返回 ${plain.status} ⇒ CSRF 可抹档`);
    assert.equal((await plain.json()).error, 'NEED_JSON');

    // (b) 跨站 Origin
    const cross = await fetch(`${base}/ctl`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'reset', confirm: true }) });
    assert.equal(cross.status, 403, `跨站 reset 返回 ${cross.status}`);
    assert.equal((await cross.json()).error, 'CROSS_SITE');

    // (c) reset 必须带 confirm
    const noConfirm = await post(base, '/ctl', { action: 'reset' });
    assert.equal(noConfirm.status, 400, `没有 confirm 的 reset 返回 ${noConfirm.status}`);
    assert.equal((await noConfirm.json()).error, 'RESET_NEEDS_CONFIRM');

    // 三种攻击之后世界必须还在原刻度
    const t1 = (await (await get(base, '/world')).json()).A.t;
    assert.equal(t1, t0, `被挡下的 reset 仍然改动了世界（t ${t0} → ${t1}）`);
    assert.equal((await get(base, '/world')).status, 200);
  } finally { await stopServer(child); }
});

test('H-03 /act 不得把 watching 顶成 true（否则无观众也烧额度）【变红法：把 /act 加回 touch 列表】', async () => {
  const { child, base } = await bootServer();
  try {
    const before = (await (await get(base, '/healthz')).json()).world.watching;
    assert.equal(before, false, '刚启动就被认为有观众');
    const r = await post(base, '/act', { kind: 'say', text: '你好' });
    assert.equal(r.status, 200);
    const after = (await (await get(base, '/healthz')).json()).world.watching;
    assert.equal(after, false, '/act 把 watching 顶成了 true ⇒ 任何人都能远程烧模型额度');
  } finally { await stopServer(child); }
});

test('H-29 HEAD 探活必须可用，且不得被算成"有观众" 【变红法：删掉 handle 开头的 HEAD 分支】', async () => {
  const { child, base } = await bootServer();
  try {
    const r = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(r.status, 200, `HEAD /healthz 返回 ${r.status}`);
    const r2 = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(r2.status, 200, `HEAD / 返回 ${r2.status}`);
    const hz = await (await get(base, '/healthz')).json();
    assert.equal(hz.world.watching, false, '一个 HEAD 探针就把 watching 顶成了 true ⇒ 监控会替世界烧额度');
  } finally { await stopServer(child); }
});

test('H-30 超长 body 映射成 413（不是 400）【变红法：把 readBody 的 BODY_TOO_LARGE 分支去掉】', async () => {
  const { child, base } = await bootServer();
  try {
    const big = JSON.stringify({ action: 'step', pad: 'x'.repeat(70 * 1024) });
    const r = await fetch(`${base}/ctl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(r.status, 413, `70KB body 返回 ${r.status}`);
    assert.equal((await r.json()).error, 'BODY_TOO_LARGE');
  } finally { await stopServer(child); }
});

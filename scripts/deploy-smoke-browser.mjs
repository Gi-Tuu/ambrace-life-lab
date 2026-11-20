#!/usr/bin/env node
// 部署冒烟（浏览器侧）：iframe/CSP 本地模拟 + 冷启动/首屏。
//
// 边界：本地模拟不能替代线上 ms.show 实测。这里做两件事：
//   1) iframe：同一份 serve.mjs 起在 http://127.0.0.1，用 Chrome 真正加载 iframe。
//      - 同源 'self'：应放行；
//      - 127.0.0.1 ↔ localhost 跨源（不在白名单）：应被 CSP 拦；
//      - https://app.ms.show 嵌在 https://platform.ms.show / modelscope.cn / www.modelscope.cn：
//        用 --host-resolver-rules 把这些域名指到本机 443 的自签 TLS 反向代理，验证通配符/精确域名两条白名单；
//      - https://evil.example：应被拦。端口必须是 443——CSP host-source 不写端口时只匹配 scheme 默认端口。
//   2) perf：在**物化树**上用 production-like env 跑 cold survival / warm title，量 gzip 与首屏请求数。
//
// 用法：
//   node scripts/deploy-smoke-browser.mjs iframe
//   node scripts/deploy-smoke-browser.mjs perf
//   node scripts/deploy-smoke-browser.mjs all
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'evidence', 'deploy-smoke');
const IMAGE = resolve(OUT, 'image-root');
const APP_PORT = Number(process.env.DEPLOY_SMOKE_APP_PORT ?? 7861);
const TLS_PORT = Number(process.env.DEPLOY_SMOKE_TLS_PORT ?? 443);
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FAKE_KEY = 'sk-smoke-FAKE-0000-not-a-real-key';
const FAKE_PROVIDER = 'https://model-endpoint.invalid/v1';
const FAKE_MODEL = 'smoke/fake-model';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[deploy-smoke-browser]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const PROD_ENV = {
  NODE_ENV: 'production', HOST: '0.0.0.0',
  GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'model',
  MODEL_PROVIDERS: FAKE_PROVIDER, MODEL_KEYS: FAKE_KEY, MODEL_NAME: FAKE_MODEL, MODEL_NAMES: '',
  PRESENCE_MS: '60000', TICK_MS: '1200',
};
// 与 debt-perf 同口径的确定性环境（仅用于对照，不代表生产）
const DEBT_ENV = {
  GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
  MODEL_UNATTENDED: '0', V73_TEST: '1',
};

// ───────── 应用服务（物化树） ─────────
function startApp() {
  const data = resolve(OUT, 'runtime-data-browser');
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, ...PROD_ENV, PORT: String(APP_PORT), DATA_DIR: data, SEED_FILE: join(IMAGE, 'seed', 'world.json') };
  delete env.MODEL_BASE_URL; delete env.MODEL_KEY; delete env.CHAT_TOKEN; delete env.CTL_TOKEN; delete env.BRAIN_RELAY_TOKEN;
  const child = spawn(process.execPath, ['serve.mjs'], { cwd: IMAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  return { child, log: () => output };
}

async function waitReady(server, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (server.log().includes('就绪')) return true;
    if (server.child.exitCode != null) return false;
    await sleep(150);
  }
  return false;
}

// ───────── 测试用自签证书（仅本机 iframe 模拟，不是仓库密钥） ─────────
function ensureCert() {
  // 手写自签证书只放临时目录，不进仓库/证据（它不是项目密钥，但也没必要入库）
  const dir = process.env.DEPLOY_SMOKE_TLS_DIR ?? join(tmpdir(), 'deploy-smoke-tls');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  mkdirSync(dir, { recursive: true });
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      new X509Certificate(readFileSync(certPath));
      return { key: readFileSync(keyPath), cert: readFileSync(certPath), dir };
    } catch { /* 重新生成 */ }
  }
  const ps1 = join(dir, 'gen.ps1');
  const psLines = [
    "$dir = '" + dir.replace(/'/g, "''") + "'",
    "$names = @('app.ms.show','platform.ms.show','other.ms.show','modelscope.cn','www.modelscope.cn','evil.example')",
    "$cert = New-SelfSignedCertificate -DnsName $names -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(30) -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable",
    "$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)",
    "$nl = [Environment]::NewLine",
    "$keyPem = '-----BEGIN PRIVATE KEY-----' + $nl + ([Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(), 'InsertLineBreaks')) + $nl + '-----END PRIVATE KEY-----' + $nl",
    "$certPem = '-----BEGIN CERTIFICATE-----' + $nl + ([Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')) + $nl + '-----END CERTIFICATE-----' + $nl",
    "[System.IO.File]::WriteAllText(\"$dir\\key.pem\", $keyPem)",
    "[System.IO.File]::WriteAllText(\"$dir\\cert.pem\", $certPem)",
    "Remove-Item \"Cert:\\CurrentUser\\My\\$($cert.Thumbprint)\"",
  ];
  writeFileSync(ps1, psLines.join('\r\n') + '\r\n');
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('生成测试证书失败：' + (r.stderr || r.stdout));
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), dir };
}

// ───────── 最小 CDP 客户端（要收事件：Log/executionContext） ─────────
function launchChrome(args) {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME);
  const profile = mkdtempSync(join(tmpdir(), 'deploy-smoke-chrome-'));
  const proc = spawn(CHROME, [...args, `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const events = [];
  let seq = 0;
  let buf = '';
  let onEvent = null;
  const writeFd = proc.stdio[3];
  const readFd = proc.stdio[4];
  readFd.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const end = buf.indexOf('\u0000');
      if (end < 0) break;
      const raw = buf.slice(0, end);
      buf = buf.slice(end + 1);
      if (!raw.trim()) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else {
        events.push(msg);
        if (onEvent) { try { onEvent(msg); } catch { /* 事件回调不影响主流程 */ } }
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolvePromise, reject) => {
    const id = (seq += 1);
    pending.set(id, { resolve: resolvePromise, reject });
    writeFd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
  });
  return { proc, send, events, profile, setOnEvent: (fn) => { onEvent = fn; } };
}

function flattenFrames(tree, out = []) {
  if (!tree) return out;
  out.push({ id: tree.frame?.id, url: tree.frame?.url, unreachableUrl: tree.frame?.unreachableUrl, origin: tree.frame?.securityOrigin });
  for (const child of tree.childFrames ?? []) flattenFrames(child, out);
  return out;
}

async function frameSnapshot(cdp, sessionId) {
  const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
  return flattenFrames(tree.frameTree);
}

async function evalInContext(cdp, sessionId, contextId, expression) {
  try {
    const params = { expression, returnByValue: true, ...(contextId != null ? { contextId } : {}) };
    const r = await cdp.send('Runtime.evaluate', params, sessionId);
    return r.result?.value;
  } catch { return undefined; }
}

// OOPIF（跨源 iframe）单独挂在 iframe target 上：直接找 target、attach、在默认上下文里查 cvA。
async function oopifCvA(cdp, wantOrigin) {
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const hits = [];
    for (const t of targetInfos) {
      if (t.type !== 'iframe' || !t.url) continue;
      let origin = '';
      try { origin = new URL(t.url).origin; } catch { continue; }
      if (origin !== wantOrigin) continue;
      hits.push(t.url);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
      if (await evalInContext(cdp, sessionId, undefined, 'Boolean(document.getElementById("cvA"))')) {
        return { url: t.url, hit: true };
      }
    }
    return { url: hits[0] ?? null, hit: false };
  } catch { return { url: null, hit: false }; }
}

async function runFrameCase(cdp, { name, parentUrl, iframeSrc, expect, injectIntoApp = false }) {
  cdp.events.length = 0;
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId).catch(() => {});
  await cdp.send('Audits.enable', {}, sessionId).catch(() => {});
  // 跨源 iframe 是 OOPIF，执行上下文在子 target 的 session 里；autoAttach 才能拿到。
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  await cdp.send('Page.navigate', { url: parentUrl }, sessionId);
  await sleep(1200);
  if (injectIntoApp) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => { const f = document.createElement('iframe'); f.id='smokeFrame'; f.src=${JSON.stringify(iframeSrc)}; f.width=640; f.height=480; document.body.appendChild(f); return f.src; })()`,
      returnByValue: true,
    }, sessionId);
  }
  const targetOrigin = new URL(iframeSrc).origin;
  let loaded = false;
  let frames = [];
  let contextHit = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    frames = await frameSnapshot(cdp, sessionId).catch(() => frames);
    const mainId = frames[0]?.id;
    const contexts = cdp.events
      .filter((e) => e.method === 'Runtime.executionContextCreated')
      .map((e) => ({ ...e.params.context, sessionId: e.sessionId ?? sessionId }))
      .filter((c) => {
        try { return new URL(c.origin).origin === new URL(targetOrigin).origin; } catch { return false; }
      })
      // 同源 case 里父页面也是目标源：只认 iframe 子 frame 的上下文
      .filter((c) => c.auxData?.frameId && c.auxData.frameId !== mainId);
    for (const ctx of contexts) {
      if (await evalInContext(cdp, ctx.sessionId, ctx.id, 'Boolean(document.getElementById("cvA"))')) {
        loaded = true; contextHit = { origin: ctx.origin, frameId: ctx.auxData?.frameId, sessionId: ctx.sessionId }; break;
      }
    }
    if (loaded) break;
    if (!loaded) {
      const oopif = await oopifCvA(cdp, new URL(targetOrigin).origin);
      if (oopif.hit) { loaded = true; contextHit = { origin: targetOrigin, frameId: null, oopif: true, url: oopif.url }; break; }
    }
    await sleep(300);
  }
  const logTexts = cdp.events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => String(e.params.entry?.text ?? ''));
  const consoleTexts = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .flatMap((e) => (e.params.args ?? []).map((a) => String(a.value ?? a.description ?? '')));
  const auditIssues = cdp.events
    .filter((e) => e.method === 'Audits.issueAdded')
    .map((e) => ({
      code: e.params.issue?.code,
      directive: e.params.issue?.details?.contentSecurityPolicyIssueDetails?.violatedDirective ?? null,
      frameAncestorsViolation: e.params.issue?.details?.contentSecurityPolicyIssueDetails?.frameAncestorsViolation ?? null,
      blockedURL: e.params.issue?.details?.contentSecurityPolicyIssueDetails?.blockedURL ?? null,
    }));
  const violations = [...logTexts, ...consoleTexts].filter((t) => /frame-ancestors/i.test(t));
  const auditViolations = auditIssues.filter((i) => i.frameAncestorsViolation || i.directive === 'frame-ancestors');
  const netFails = cdp.events
    .filter((e) => e.method === 'Network.loadingFailed')
    .map((e) => ({ id: e.params.requestId, error: e.params.errorText, blocked: e.params.blockedReason, cors: e.params.corsErrorStatus?.corsError ?? null }));
  const netReqs = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request.url)
    .filter((u) => u.includes('app.ms.show'));
  const frameUrls = frames.map((f) => f.url || f.unreachableUrl).filter(Boolean);
  let parentDiag = null;
  try {
    parentDiag = await cdp.send('Runtime.evaluate', {
      expression: `({ title: document.title, iframes: document.querySelectorAll('iframe').length, hasCvA: Boolean(document.getElementById('cvA')), href: location.href, body: document.body ? document.body.innerText.slice(0, 120) : '' })`,
      returnByValue: true,
    }, sessionId).then((r) => r.result?.value ?? null);
  } catch { /* 父页已关 */ }
  const result = {
    name, parentUrl, iframeSrc, expect, loaded,
    context: contextHit,
    frameUrls,
    parentDiag,
    netReqs: netReqs.slice(0, 5), netFails: netFails.slice(0, 5),
    violations: violations.slice(0, 5),
    auditIssues: auditIssues.slice(0, 5),
    logs: [...logTexts, ...consoleTexts].slice(-8),
    verdict: loaded ? 'loaded' : (violations.length || auditViolations.length ? 'blocked-csp' : 'not-loaded-no-csp-evidence'),
  };
  await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
  return result;
}

async function directLoad(cdp, url) {
  cdp.events.length = 0;
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const want = new URL(url).origin;
  let loaded = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ctxs = cdp.events.filter((e) => e.method === 'Runtime.executionContextCreated')
      .map((e) => ({ ...e.params.context, sessionId: e.sessionId ?? sessionId }))
      .filter((c) => { try { return new URL(c.origin).origin === new URL(want).origin; } catch { return false; } });
    for (const c of ctxs) {
      if (await evalInContext(cdp, c.sessionId, c.id, 'Boolean(document.getElementById("cvA"))')) { loaded = true; break; }
    }
    if (loaded) break;
    await sleep(300);
  }
  await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
  return loaded;
}

async function iframe() {
  const cert = ensureCert();
  const app = startApp();
  const ready = await waitReady(app);
  check('iframe 模拟：应用服务就绪', ready, ready ? '' : app.log().slice(0, 400));
  if (!ready) { app.child.kill(); throw new Error('应用服务未就绪'); }

  const parentHtml = `<!doctype html><meta charset="utf-8"><title>smoke-parent</title>
<body style="margin:0"><iframe id="f" src="https://app.ms.show/" width="640" height="480"></iframe></body>`;
  const plainParentHtml = (src) => `<!doctype html><meta charset="utf-8"><title>smoke-plain-parent</title>
<body style="margin:0"><iframe id="f" src="${src}" width="640" height="480"></iframe></body>`;
  // 无 CSP 的普通父页服务器：跨源嵌入的判定必须只由**被嵌页**的 frame-ancestors 决定，
  // 不能拿应用自己的 default-src 'self' 当证据（那会把 frame-src 回退也算成"被拦"）。
  const plainParent = createHttpServer((req, res) => {
    const src = req.url === '/parent-http.html' ? `http://127.0.0.1:${APP_PORT}/`
      : (req.url === '/parent-https.html' || req.url === '/') ? 'https://app.ms.show/' : null;
    if (!src) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(plainParentHtml(src));
  });
  await new Promise((resolvePromise) => plainParent.listen(APP_PORT + 1, '127.0.0.1', resolvePromise));
  const proxy = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    proxyHits.push(`${req.headers.host}${req.url}`);
    if (req.url === '/parent.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(parentHtml);
      return;
    }
    const upstream = httpRequest({ host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('proxy error'); });
    req.pipe(upstream);
  });
  await new Promise((resolvePromise, reject) => {
    proxy.once('error', reject);
    proxy.listen(TLS_PORT, '127.0.0.1', resolvePromise);
  }).catch((error) => { throw new Error(`TLS 代理无法监听 127.0.0.1:${TLS_PORT}（iframe 白名单测试需要 443）：${error?.message ?? error}`); });

  const chrome = launchChrome([
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
    '--ignore-certificate-errors',
    // 本机装了 PAC/系统代理时，host-resolver-rules 会被代理接管而失效（实测 app.ms.show 被公网解析并重定向）；
    // --no-proxy-server 只影响这个冒烟 Chrome，让它真的按 MAP 走本机。
    '--no-proxy-server',
    // 平台域名被 MAP 到 127.0.0.1 后，Chrome 会把"公网源 → 本机 IP"判成 Private/Local Network Access 而静默拦掉；
    // 这是本地模拟的额外层，不是线上行为，测试里关掉。
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
    '--host-resolver-rules=MAP localhost 127.0.0.1, MAP app.ms.show 127.0.0.1, MAP platform.ms.show 127.0.0.1, MAP other.ms.show 127.0.0.1, MAP modelscope.cn 127.0.0.1, MAP www.modelscope.cn 127.0.0.1, MAP evil.example 127.0.0.1',
  ]);
  await sleep(500);
  // OOPIF 子 target 的 Runtime/Log 要单独 enable，否则拿不到子 frame 的上下文与 CSP 报告。
  chrome.setOnEvent((msg) => {
    if (msg.method === 'Target.attachedToTarget' && msg.sessionId) {
      const sid = msg.sessionId;
      chrome.send('Runtime.enable', {}, sid).catch(() => {});
      chrome.send('Log.enable', {}, sid).catch(() => {});
      chrome.send('Audits.enable', {}, sid).catch(() => {});
    }
  });
  const cases = [];
  const direct = {};
  const proxyHits = [];
  try {
    cases.push(await runFrameCase(chrome, {
      name: 'same-origin-self', parentUrl: `http://127.0.0.1:${APP_PORT}/`, iframeSrc: `http://127.0.0.1:${APP_PORT}/`,
      expect: 'allowed', injectIntoApp: true,
    }));
    cases.push(await runFrameCase(chrome, {
      name: 'cross-origin-port', parentUrl: `http://127.0.0.1:${APP_PORT + 1}/parent-http.html`, iframeSrc: `http://127.0.0.1:${APP_PORT}/`,
      expect: 'blocked',
    }));
    for (const host of ['platform.ms.show', 'app.ms.show', 'modelscope.cn', 'www.modelscope.cn']) {
      cases.push(await runFrameCase(chrome, {
        name: `https-${host}`, parentUrl: `https://${host}/parent.html`, iframeSrc: 'https://app.ms.show/',
        expect: host === 'app.ms.show' ? 'allowed(self)' : 'allowed(whitelist)',
      }));
    }
    cases.push(await runFrameCase(chrome, {
      name: 'https-evil.example', parentUrl: 'https://evil.example/parent.html', iframeSrc: 'https://app.ms.show/',
      expect: 'blocked',
    }));
    const httpParent = await runFrameCase(chrome, {
      name: 'https-frame-in-http-parent', parentUrl: `http://127.0.0.1:${APP_PORT + 1}/parent-https.html`, iframeSrc: 'https://app.ms.show/',
      expect: 'blocked',
    });
    cases.push(httpParent);

    // 对照：同一个 iframe URL 作为顶层页面直开必须能渲染。这样"嵌不进去"才归因于 CSP，而不是连不上。
    for (const url of [...new Set(cases.map((c) => c.iframeSrc))]) direct[url] = await directLoad(chrome, url);
  } finally {
    try { chrome.proc.kill(); } catch { /* 已退出 */ }
    proxy.close();
    plainParent.close();
    app.child.kill();
    await sleep(400);
  }

  for (const c of cases) {
    const blockedEvidence = c.violations.length > 0 || c.auditIssues.some((i) => i.frameAncestorsViolation || i.directive === 'frame-ancestors');
    const ok = c.expect.startsWith('allowed') ? c.loaded : (!c.loaded && blockedEvidence && direct[c.iframeSrc] === true);
    check(`iframe ${c.name} 期望 ${c.expect}`, ok,
      `loaded=${c.loaded} 顶层直开=${direct[c.iframeSrc]} ctx=${c.context?.origin ?? '无'} frameUrls=${JSON.stringify(c.frameUrls.slice(0, 3))} csp=${c.violations[0]?.slice(0, 120) ?? '无'} audit=${JSON.stringify(c.auditIssues.slice(0, 1))}`);
  }
  const positive = cases.filter((c) => c.expect.startsWith('allowed'));
  check('iframe 白名单：同源 + *.ms.show + modelscope.cn + www.modelscope.cn 全部实际放行',
    positive.every((c) => c.loaded), positive.map((c) => `${c.name}=${c.loaded}`).join(', '));
  check('iframe 白名单外（跨端口 / evil.example / http 父页）全部被 CSP 拦，且目标 URL 顶层直开可渲染',
    cases.filter((c) => c.expect === 'blocked').every((c) => !c.loaded && direct[c.iframeSrc] === true
      && (c.violations.length > 0 || c.auditIssues.some((i) => i.frameAncestorsViolation || i.directive === 'frame-ancestors'))));
  check('iframe 对照：iframe 目标 URL 顶层直开可渲染', Object.values(direct).every(Boolean), JSON.stringify(direct));
  writeFileSync(join(OUT, 'iframe.json'), JSON.stringify({
    at: new Date().toISOString(),
    mode: 'local-simulation-only',
    note: '本地模拟：Chrome --host-resolver-rules 把平台域名指到本机 443 自签 TLS 反向代理；不能替代 ms.show 线上实测。',
    app: `http://127.0.0.1:${APP_PORT}`, tlsProxy: `https://127.0.0.1:${TLS_PORT}`, proxyHits: proxyHits.slice(-40), cases, checks,
  }, null, 2) + '\n');
  return cases;
}

// ───────── 冷启动 / 首屏 ─────────
const PROBE = `(() => {
  const p = window.__p3 = { marks: {} };
  const watch = () => {
    for (const id of ['cvA','startScene']) {
      const cv = document.getElementById(id);
      if (!cv) continue;
      const check = () => { if (cv.dataset.renderer && !p.marks['renderer:' + id]) p.marks['renderer:' + id] = performance.now(); };
      check();
      new MutationObserver(check).observe(cv, { attributes: true, attributeFilter: ['data-renderer'] });
    }
  };
  document.addEventListener('DOMContentLoaded', watch);
})();`;

async function perfConfig(label, port, serverEnv, reps) {
  const h = createCdpHarness({
    root: IMAGE,
    port,
    dataPrefix: `deploy-smoke-${label}-data-`,
    profilePrefix: `deploy-smoke-${label}-chrome-`,
    chromeArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
    serverEnv: { ...serverEnv, SEED_FILE: join(IMAGE, 'seed', 'world.json') },
    readyAttempts: 200,
    waitMs: 30000,
    waitIntervalMs: 100,
  });
  const runs = [];
  try {
    await h.startServer();
    for (let i = 0; i < reps; i += 1) {
      h.startChrome();
      const sid = await h.newPage({ probe: PROBE });
      await h.send('Page.navigate', { url: `${h.origin}/?mode=survival` }, sid);
      const ok = await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:cvA'] ?? null`, sid)), 45000, sid);
      if (!ok) {
        const diag = await h.evaluate(`({ title: document.title, href: location.href, cvA: document.getElementById('cvA') ? document.getElementById('cvA').dataset.renderer ?? null : 'no-canvas', body: (document.body?.innerText ?? '').slice(0, 200), marks: window.__p3?.marks ?? null, resources: performance.getEntriesByType('resource').length })`, sid).catch((e) => ({ err: String(e) }));
        throw new Error(`${label} cold survival 首帧未渲染：` + JSON.stringify(diag));
      }
      const coldSurvival = await h.evaluate(`window.__p3.marks['renderer:cvA']`, sid);
      const requests = await h.evaluate(`performance.getEntriesByType('resource').filter(r => r.name.startsWith(location.origin)).length`, sid);
      const resources = await h.evaluate(`performance.getEntriesByType('resource').filter(r => r.name.startsWith(location.origin)).map(r => ({ name: r.name.replace(location.origin,''), encoded: r.encodedBodySize, decoded: r.decodedBodySize, transfer: r.transferSize }))`, sid);
      const webgl = await h.evaluate(`(() => { try { const c=document.createElement('canvas'); const g=c.getContext('webgl'); const d=g.getExtension('WEBGL_debug_renderer_info'); return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):'unknown'; } catch { return null; } })()`, sid);
      await h.closePages();
      const sidT = await h.newPage({ probe: PROBE });
      await h.send('Page.navigate', { url: `${h.origin}/` }, sidT);
      const okT = await h.waitFor(async () => Boolean(await h.evaluate(`window.__p3?.marks?.['renderer:startScene'] ?? null`, sidT)), 45000, sidT);
      if (!okT) throw new Error(`${label} warm title 首帧未渲染`);
      const warmTitle = await h.evaluate(`window.__p3.marks['renderer:startScene']`, sidT);
      const run = {
        i, coldSurvival: Number(coldSurvival.toFixed(1)), warmTitle: Number(warmTitle.toFixed(1)), requests,
        appJs: resources.find((r) => r.name === '/web/app.js') ?? null,
        indexHtml: resources.find((r) => r.name === '/web/index.html') ?? resources.find((r) => r.name === '/') ?? null,
        world: resources.find((r) => r.name.startsWith('/world')) ?? null,
        webgl,
      };
      runs.push(run);
      console.log(`[perf ${label}] rep ${i + 1}/${reps}`, JSON.stringify(run));
      await h.killChrome({ settleMs: 400 });
    }
  } finally {
    await h.killChrome({ settleMs: 200 }).catch(() => {});
    await h.stopServer({ settleMs: 100 }).catch(() => {});
    await h.close({ settleMs: 200 }).catch(() => {});
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  return {
    label, env: serverEnv, runs,
    summary: {
      coldSurvival: { median: median(runs.map((r) => r.coldSurvival)), max: Math.max(...runs.map((r) => r.coldSurvival)), all: runs.map((r) => r.coldSurvival) },
      warmTitle: { median: median(runs.map((r) => r.warmTitle)), max: Math.max(...runs.map((r) => r.warmTitle)), all: runs.map((r) => r.warmTitle) },
      requests: { median: median(runs.map((r) => r.requests)), max: Math.max(...runs.map((r) => r.requests)), all: runs.map((r) => r.requests) },
      appJs: runs[0]?.appJs ?? null, world: runs[0]?.world ?? null,
    },
  };
}

async function perf() {
  const REPS = Math.max(1, Number(process.env.DEPLOY_SMOKE_REPS ?? 3));
  const real = await perfConfig('prod-like', 9621, PROD_ENV, REPS);
  const debt = await perfConfig('debt-baseline', 9622, DEBT_ENV, REPS);
  const gzipOk = Boolean(real.summary.appJs && real.summary.appJs.encoded > 0 && real.summary.appJs.encoded < real.summary.appJs.decoded);
  check('首屏 app.js 在浏览器里实际走 gzip（encoded < decoded）', gzipOk,
    real.summary.appJs ? `${real.summary.appJs.decoded} → ${real.summary.appJs.encoded} B` : '无资源计时');
  check('首屏请求数 ≤ 60（production-like，中位）', real.summary.requests.median <= 60, `all=${JSON.stringify(real.summary.requests.all)}`);
  check('cold survival 首帧 < 800 ms（production-like，中位）', real.summary.coldSurvival.median < 800,
    `median=${real.summary.coldSurvival.median} all=${JSON.stringify(real.summary.coldSurvival.all)} max=${real.summary.coldSurvival.max}`);
  check('warm title 首帧 < 600 ms（production-like，中位）', real.summary.warmTitle.median < 600,
    `median=${real.summary.warmTitle.median} all=${JSON.stringify(real.summary.warmTitle.all)} max=${real.summary.warmTitle.max}`);
  const result = {
    at: new Date().toISOString(),
    mode: 'cdp-harness on materialized tree (not container)',
    envNote: {
      node: process.version, platform: process.platform,
      reps: Number(process.env.DEPLOY_SMOKE_REPS ?? 3),
      harness: 'scripts/lib/cdp-harness.mjs（headless=new --disable-gpu，SwiftShader 软件光栅）',
      imageTree: IMAGE,
      prodEnv: { ...PROD_ENV, MODEL_KEYS: '<redacted-fake>' }, debtEnv: DEBT_ENV,
      debtPerfReference: { coldSurvival: [688.1, 680.6], warmTitle: [509.1, 498.8], requests: [51, 47, 51, 49], appJs: '265,891 → 98,896 B', world: '146,473 → 19,851 B' },
      difference: '本机 Node v24 + Windows 直接跑物化树；debt-perf 是同一 harness/同一机器上的仓库根运行。非容器 node:22-alpine，非真机 GPU。',
    },
    configs: [{ ...real, env: { ...real.env, MODEL_KEYS: '<redacted-fake>' } }, debt], checks,
  };
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

// ───────── 入口 ─────────
const step = process.argv[2] ?? 'all';
try {
  if (!existsSync(join(IMAGE, 'serve.mjs'))) throw new Error('物化树不存在：先跑 node scripts/deploy-smoke.mjs build');
  if (step === 'iframe') await iframe();
  else if (step === 'perf') await perf();
  else if (step === 'all') { await iframe(); await perf(); }
  else { console.error('用法: node scripts/deploy-smoke-browser.mjs [iframe|perf|all]'); process.exitCode = 2; }
  const failed = checks.filter((c) => !c.ok);
  log(`checks: ${checks.length - failed.length}/${checks.length} pass`);
  if (failed.length) { console.error('[deploy-smoke-browser] FAILED:', failed.map((f) => f.name).join(' | ')); process.exitCode = 1; }
} catch (error) {
  console.error('[deploy-smoke-browser] ERROR', error?.stack ?? error);
  process.exitCode = 1;
}

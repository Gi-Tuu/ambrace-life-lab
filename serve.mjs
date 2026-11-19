// 零依赖静态 + 转发 + 权威世界宿主。
// 为什么世界状态必须在服务端：内部状态「持续存在」是这套架构的主张本身。
// 放在浏览器里，关标签页就重置；魔搭免费创空间还会休眠 —— 两者都会当面打脸这个主张。
// 密钥只留在服务端进程，绝不进前端、公开源码或构建产物。
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { extname, join, sep, resolve } from 'node:path';
import { host, listCamps, openCamp, backToMainCamp, modelGate, modelCharged, modelRelease, pickProviderKey, modelChargeLane, isFreeProvider } from './life/host.mjs';
import { mutatingDenied, interactionDenied, ctlDenied, tokenMatches, bearerOf, isJson, DESTRUCTIVE_CTL } from './life/request-guard.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeName } from './life/camp-instances.mjs';
import { createRelay, constantTimeEqual } from './life/brain-relay.mjs';

const ROOT = resolve('.');
// 魔搭创空间 Docker 约定监听 0.0.0.0:7860
const PORT = Number(process.env.PORT ?? 7860);
const HOST = process.env.HOST ?? '0.0.0.0';
// 供应商可替换：主端点失败按顺序退到下一个（魔搭 API-Inference 优先，第三方兜底）
const PROVIDERS = (process.env.MODEL_PROVIDERS ?? process.env.MODEL_BASE_URL ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const KEYS = (process.env.MODEL_KEYS ?? process.env.MODEL_KEY ?? '').split(',').map((s) => s.trim());
const providerKey = i => pickProviderKey(KEYS, i, PROVIDERS.length);
const MODEL = process.env.MODEL_NAME ?? '';
// 每家供应商的模型 id 前缀可能不同（魔搭 deepseek-ai/ vs 第三方 deepseek/）：按位对应，缺位退回 MODEL
const MODELS = (process.env.MODEL_NAMES ?? '').split(',').map((s) => s.trim());
const UP_TIMEOUT_MS = Number(process.env.UP_TIMEOUT_MS ?? 25000);
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

// SEC5-06：统一安全头。CSP 只放同源脚本/样式/图片；防点击劫持靠 frame-ancestors 白名单。
// 白名单是必须的而不是可选项：创空间永远以 iframe 嵌 *.ms.show 呈现，'none' 会让平台那一格
// 被浏览器拦成空白页（2026-11-19 线上白屏的真因）。x-frame-options 表达不了"允许某个源"，
// 留着 DENY 只会比 CSP 更严，所以这里去掉它，由 CSP 的白名单单独把关。
const FRAME_ANCESTORS = "frame-ancestors 'self' https://modelscope.cn https://www.modelscope.cn";
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " + FRAME_ANCESTORS,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
});
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { const e = new Error('BODY_TOO_LARGE'); e.code = 'BODY_TOO_LARGE'; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// BUG-19：静态面改**白名单 + realpath**。原来的黑名单挡不住 Windows 的大小写不敏感、
// %2e%2e%2f、junction，也没列举过 /docs、/.git、/contest.txt —— 本地跑 serve 就能读到仓库内部文件。
// 去掉旧 2D 后浏览器直接 import shared/ 的纯数据/几何，白名单是 web/ 与 shared/ 两棵树；
// P2：浏览器玩家移动复用 life/space.mjs 的纯查询，只额外放行这一个文件（不开放整个 life/）。
const STATIC_BASES = { web: join(ROOT, 'web'), shared: join(ROOT, 'shared'), life: join(ROOT, 'life') };

async function serveStatic(req, res, urlPath, search = '') {
  let rel;
  try { rel = decodeURIComponent(String(urlPath)); } catch { return json(res, 400, { error: 'BAD_PATH' }); }
  if (rel === '/index.html') rel = '/web/index.html';
  const tree = rel.startsWith('/web/') ? 'web' : rel.startsWith('/shared/') ? 'shared' :
    rel === '/life/space.mjs' ? 'life' : null;
  if (!tree) return json(res, 404, { error: 'NOT_FOUND' });
  const target = resolve(ROOT, '.' + rel);
  let real, base;
  try {
    [real, base] = await Promise.all([realpath(target), realpath(STATIC_BASES[tree])]);
  } catch { return json(res, 404, { error: 'NOT_FOUND' }); }
  // realpath 之后再比：符号链接 / junction / .. 都已经被展开。Windows 路径不区分大小写，统一小写比。
  const r = real.toLowerCase();
  const b = base.toLowerCase();
  // H-17：越界一律 404，不再用 403 区分"路径存在但被拒"与"不存在"——
  // 403/404 混用会把这个端点变成任意文件系统的存在性探针。
  if (r !== b && !r.startsWith(b + sep.toLowerCase())) return json(res, 404, { error: 'NOT_FOUND' });
  try {
    const info = await stat(real);
    if (info.isDirectory()) return json(res, 404, { error: 'NOT_FOUND' });
    const buf = await readFile(real);
    // 缓存（P0）：不再全站 no-store。静态文本/素材带内容 ETag，刷新走 304（只花一个 RTT，不重传）；
    // 带 ?v=<指纹> 的请求按内容寻址，可以长缓存 immutable。HTML/JS 没有指纹 ⇒ no-cache 每次复验。
    const etag = '"' + createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"';
    const immutable = /(?:^|&)v=[\w.-]{6,}/.test(search.startsWith('?') ? search.slice(1) : search);
    const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate';
    const headers = { ...SECURITY_HEADERS, etag, 'cache-control': cacheControl };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': MIME[extname(real)] ?? 'application/octet-stream', 'content-length': buf.length });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'NOT_FOUND' });
  }
}

// BUG-8：/chat 是一条带服务器密钥的转发通道。没有配 CHAT_TOKEN 就整个端点 404 ——
// 默认关闭而不是默认开放；配了则要求 Bearer/ x-chat-token 完全一致。
const CHAT_TOKEN = process.env.CHAT_TOKEN ?? '';

// 定长比较：避免用长度或前缀差异做旁路探测
function chatAuthorized(req) {
  if (!CHAT_TOKEN) return false;
  const h = String(req.headers.authorization ?? '');
  const got = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-chat-token'] ?? '');
  if (got.length !== CHAT_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ CHAT_TOKEN.charCodeAt(i);
  return diff === 0;
}

// ─────────────────── 大脑中继：把"问模型"外包给赛事云节点 ───────────────────
// 节点不开任何入站端口：它自己每隔 POLL_MS 出站来 /brain/claim 取活、跑本地 vLLM、再 POST /brain/result 交回。
// 对引擎而言这只是一个普通的 OpenAI 兼容供应商（MODEL_PROVIDERS 指到 /brain/v1），
// 因此 host.mjs 一行没动；节点不在/超时 ⇒ 这里回 5xx ⇒ 引擎的供应商循环自动落到下一个回退位。
// 与 /chat 同一条纪律：没配 BRAIN_RELAY_TOKEN 就整组端点 404 —— 默认关闭，而不是默认开放。
// 两个调用方持有的是不同的东西，必须分开认：
//   · 引擎入口（容器内）发的是 MODEL_KEYS[0]——那是密文变量，平台不回显，我们插不进新令牌，所以这里额外认它；
//     能拿出这把密钥的只有容器自己（外部拿到它的话，他本来就能直接用它调托管推理，边界没有变宽）。
//   · 节点 agent（容器外）发的是 BRAIN_RELAY_TOKEN 本身。
const RELAY_TOKEN = process.env.BRAIN_RELAY_TOKEN ?? '';
const ENGINE_KEY = String(KEYS[0] ?? '');
const brainRelay = createRelay({
  maxPending: Number(process.env.BRAIN_RELAY_PENDING ?? 8) || 8,
  ttlMs: Number(process.env.BRAIN_RELAY_TTL_MS ?? 4500) || 4500 // 名义上要小于 MODEL_TIMEOUT_MS，但游戏态默认 MODEL_TIMEOUT_MS=4000 < 4500：引擎先走、agent 跑完再交回来只会被记 late。
  // 实测（2026-11-17，60 条同题、并发 2）27B 审议 P95 8798ms ⇒ 38% 注定落不了地；把车道挪到 :9027 才是解法，不是把这个数往上抬（抬了就要付世界变慢的代价）。
});

const relayAuthorized = (req) => constantTimeEqual(relayPresented(req), RELAY_TOKEN);
// 引擎侧入口：中继令牌或容器自己的模型密钥，二者之一即可。
const engineAuthorized = (req) => {
  const got = relayPresented(req);
  return constantTimeEqual(got, RELAY_TOKEN) || (Boolean(ENGINE_KEY) && constantTimeEqual(got, ENGINE_KEY));
};

function relayPresented(req) {
  // 魔搭网关会改写/丢弃自定义鉴权头（实测 Authorization 与 x-brain-token 都到不了容器），
  // 但查询参数能过（studio_token 就是它带进来的），所以这里三处都认，取第一个非空。
  try {
    const q = new URL(req.url, 'http://relay.local').searchParams.get('relay_token');
    if (q) return String(q);
  } catch { /* 畸形 URL 由路由前段的 BAD_URL 兜住 */ }
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-brain-token'] ?? '');
}

async function readJsonBody(req) {
  try {
    return { ok: true, value: JSON.parse(await readBody(req)) };
  } catch {
    return { ok: false };
  }
}

// ─────────────────── 请求守卫（第二次审计 H-01 / H-02 / H-03；质量审查 §5.1 加固）───────────────────
// 守卫本体在 life/request-guard.mjs（纯函数、可单测）；这里只读环境变量并调用。
// 非 loopback 的写请求必须出示浏览器同源证据或 CTL_TOKEN，二者皆无一律拒（脚本无 Origin 也能 reset 的洞）。
const CTL_TOKEN = process.env.CTL_TOKEN ?? '';
// 守卫语义（审计 SEC-02 之后）：**配了 CTL_TOKEN 就只认令牌**，浏览器同源证据不再放行；
// 不配时写路由靠浏览器同源证据。⇒ 生产**不设** CTL_TOKEN（所有者 2026-11-16 拍板）：
// 公开前端发不出 Bearer，一设令牌全体访客的 /act、/ctl、/saves/open 都会 401——就是 11-16 早上那次线上全停的形态。
// 下面 boot 时会把这件事显式警告出来，免得下次有人"顺手补个令牌"。
// 审计 SEC-03：/saves/open 会同步 fork + gzip + 量索引重写；不限速会被用来打爆磁盘/事件循环。
// 第七轮更正：**不能按 remoteAddress 分桶**——创空间网关把所有访客都送到同一个地址，
// 按 IP 限等于给整站设一个"每分钟 5 人建档"的总闸（第 6 人起 429）。现在按**营地名**分桶，
// 另设一个显式的全局桶当防滥用层；两层都是限速，回显的错误码不区分是哪一层挡的（不透露内部阈值）。
const positiveInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const OPEN_LIMIT = positiveInt(process.env.OPEN_LIMIT, 5);          // 同一个营地名，每分钟最多这么多次
const OPEN_LIMIT_GLOBAL = positiveInt(process.env.OPEN_LIMIT_GLOBAL, 60); // 整站每分钟总量（防刷名造营地）
const OPEN_SESSION_LIMIT = positiveInt(process.env.OPEN_SESSION_LIMIT, 5); // 同一个浏览器会话最多建几个营地/分钟
const OPEN_WINDOW_MS = 60_000;
const CAMP_TOTAL_MAX = positiveInt(process.env.CAMP_TOTAL_MAX, 50);
const openBuckets = new Map();
function openAllowed(bucket, limit) {
  const now = Date.now();
  const hits = (openBuckets.get(bucket) ?? []).filter((t) => now - t < OPEN_WINDOW_MS);
  if (hits.length >= limit) {
    if (hits.length) openBuckets.set(bucket, hits); else openBuckets.delete(bucket);
    return false;
  }
  hits.push(now);
  openBuckets.set(bucket, hits);
  // 名字是外部输入，桶键必须自己有界：过期即删，超量整体回收。
  if (openBuckets.size > 256) {
    for (const [k, arr] of openBuckets) if (!arr.some((t) => now - t < OPEN_WINDOW_MS)) openBuckets.delete(k);
  }
  return true;
}
// 桶键**复用营地名的正典归一化**（同一个营地 ⇒ 同一个桶，不另起一套大小写/空白规则）；
// 非法名字全部并进同一个桶——这样"随机刷名字"既造不出营地，也撑不爆这张表。原始名字不进键、不回显、不落盘。
const openBucketKey = (name) => {
  const n = normalizeName(name);
  return n.ok ? `n:${n.key}` : 'n:invalid';
};

async function chatProxy(req, res) {
  let charged = false;
  try {
    if (!PROVIDERS.some((_, i) => providerKey(i))) return json(res, 503, { error: 'NO_BACKEND', note: '未配置模型端点，世界自动退回本地替身' });
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (error) {
      const tooLarge = error.code === 'BODY_TOO_LARGE';
      return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'BODY_TOO_LARGE' : 'BAD_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'BAD_JSON' });
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 8) : [];
    const attempts = [];
    for (let i = 0; i < PROVIDERS.length; i++) {
      const key = providerKey(i), model = MODELS[i] || MODEL;
      if (!key || !model) continue;
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), UP_TIMEOUT_MS);
      try {
        const up = await fetch(`${PROVIDERS[i]}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, temperature: Math.min(1.2, Math.max(0, Number(body.temperature) || 0.85)), messages, response_format: { type: 'json_object' }, max_tokens: 120 }),
          signal: ac.signal,
        });
        const text = await up.text();
        if (!up.ok) { attempts.push(`${PROVIDERS[i].replace(/^https:\/\//, '')} → HTTP ${up.status}`); continue; }
        const j = JSON.parse(text);
        modelCharged(j.usage?.total_tokens ?? 0);
        modelChargeLane(isFreeProvider(PROVIDERS[i]));
        charged = true;
        // 只回内容和用量：不透传上游原始响应，也不回端点/尝试明细（那等于告诉对方配了哪些供应商）
        return json(res, 200, { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {} });
      } catch (e) {
        attempts.push(`${PROVIDERS[i].replace(/^https:\/\//, '')} → ${String(e.message).slice(0, 50)}`);
      } finally {
        clearTimeout(to);
      }
    }
    return json(res, 502, { error: 'ALL_PROVIDERS_FAILED', tries: attempts.length });
  } finally {
    if (!charged) modelRelease();
  }
}

function cookieValue(req, name) {
  return String(req?.headers?.cookie ?? '').split(';').map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
const ownerHashOf = (token) => createHash('sha256').update(String(token)).digest('hex');
// SEC5-02：非 MAIN 营地的读路径也必须出示匹配的 camp_owner。MAIN 没有 owner，读/普通动作开放；
// 它的破坏性重置由 /ctl 的会话 nonce（未设令牌时）或 CTL_TOKEN（设了令牌时）单独把关。
const ownerAllows = (req, key) => {
  if (!key || key === 'MAIN') return true;
  const hash = host.campOwnerHash(key);
  const tokenOk = Boolean(CTL_TOKEN) && tokenMatches(bearerOf(req), CTL_TOKEN);
  if (tokenOk) return true;
  const owner = cookieValue(req, 'camp_owner');
  if (!hash) {
    // 旧档没有 ownerHash：第一次带 owner cookie 的访客绑定它；无 cookie 一律拒绝。
    if (!owner) return false;
    try { host.claimCamp(key, ownerHashOf(owner)); } catch { /* 索引锁冲突：本次按无 owner 拒绝 */ return false; }
    return true;
  }
  return Boolean(owner) && ownerHashOf(owner) === hash;
};

// ── SEC5-01：服务端签发的会话 + nonce ───────────────────────────────
// nonce 不是客户端自选值：服务端为每个 ctl_sid 生成随机 nonce 并保存在进程内；
// 校验时必须同时满足 ① 会话存在 ② cookie nonce == 服务端 nonce ③ 请求头 nonce == 服务端 nonce。
// 这样“自设 cookie/header 对”无法通过。HttpOnly 会话 cookie 防 JS 读取；SameSite=Strict 防跨站携带。
// 注意：这是 CSRF 防护，不是账号体系——未配置 CTL_TOKEN 时，能完成一次 GET 的脚本仍能拿到会话；
// 公开部署应配置 CTL_TOKEN（破坏性动作只认令牌）。
const CTL_SESSION_TTL_MS = positiveInt(process.env.CTL_SESSION_TTL_MS, 12 * 60 * 60 * 1000);
const CTL_SESSION_MAX = positiveInt(process.env.CTL_SESSION_MAX, 5000);
// MAIN reset 用的一次性 nonce 窗口：60s 内有效，用过即轮换；并做全局 3 次/分钟限速。
const CTL_NONCE_TTL_MS = positiveInt(process.env.CTL_NONCE_TTL_MS, 60_000);
const MAIN_RESET_LIMIT = positiveInt(process.env.MAIN_RESET_LIMIT, 3);
const MAIN_RESET_WINDOW_MS = positiveInt(process.env.MAIN_RESET_WINDOW_MS, 60_000);
const ctlSessions = new Map();
const mainResetTimes = [];
const secureCookie = (req) => process.env.COOKIE_SECURE === '1'
  || Boolean(req?.socket?.encrypted)
  || String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
const cookieSecureFlag = (req) => secureCookie(req) ? '; Secure' : '';
// 线上创空间是把 ms.show 嵌进 modelscope.cn 的第三方 iframe：这种请求里 SameSite=Lax 的 cookie
// **不会被带上**，于是"建档成功、下一次读营地就 403"——名字存档在创空间页面里等于不可用。
// 跨站携带只有 SameSite=None; Secure 能过；本地 http（非安全上下文）浏览器会丢掉 None 的 cookie，
// 所以只在安全上下文用 None，其余保持 Lax。
const campCookieScope = (req) => secureCookie(req) ? 'SameSite=None; Secure' : 'SameSite=Lax';
const mainResetSid = (req) => String(req?.ctlSid ?? '').slice(0, 8);
function auditMainReset(req, result) {
  // 审计事件只落 stderr：时间 / sid 前缀 / 结果。不写令牌、不写 nonce 原文。
  console.error('[audit] main_reset ' + JSON.stringify({ at: new Date().toISOString(), sid: mainResetSid(req), result: String(result) }));
}
function rotateNonce(rec) {
  rec.nonce = randomBytes(16).toString('hex');
  rec.nonceAt = Date.now();
}
function pruneSessions(now) {
  for (const [sid, rec] of ctlSessions) if (rec.expires <= now) ctlSessions.delete(sid);
  if (ctlSessions.size <= CTL_SESSION_MAX) return;
  // 极端覆盖：按过期时间删最旧的一半，保证表有界。
  const olds = [...ctlSessions.entries()].sort((a, b) => a[1].expires - b[1].expires);
  for (let i = 0; i < Math.ceil(olds.length / 2); i += 1) ctlSessions.delete(olds[i][0]);
}
function issueCtlSession(req, res) {
  const now = Date.now();
  pruneSessions(now);
  const sid = cookieValue(req, 'ctl_sid');
  let rec = sid ? ctlSessions.get(sid) : null;
  if (!rec || rec.expires <= now) {
    const freshSid = randomBytes(16).toString('hex');
    rec = { nonce: randomBytes(16).toString('hex'), nonceAt: now, expires: now + CTL_SESSION_TTL_MS };
    ctlSessions.set(freshSid, rec);
    req.ctlSid = freshSid;
    req.ctlNonce = rec.nonce;
    res.appendHeader('set-cookie', `ctl_sid=${freshSid}; Path=/; HttpOnly; SameSite=Strict${cookieSecureFlag(req)}`);
  } else {
    req.ctlSid = sid;
    // 短 TTL：nonce 过期自动轮换（前端每次请求都会从响应拿到新 cookie）。
    if (!(now - (rec.nonceAt ?? 0) <= CTL_NONCE_TTL_MS)) rotateNonce(rec);
    req.ctlNonce = rec.nonce;
    rec.expires = now + CTL_SESSION_TTL_MS;
  }
  // 总是覆盖客户端传来的 nonce cookie，服务端值才是唯一真相。
  res.appendHeader('set-cookie', `ctl_nonce=${rec.nonce}; Path=/; SameSite=Strict${cookieSecureFlag(req)}`);
  return rec;
}
function consumeCtlNonce(req, res) {
  const rec = req.ctlSid ? ctlSessions.get(req.ctlSid) : null;
  if (!rec) return;
  rotateNonce(rec);
  res.appendHeader('set-cookie', `ctl_nonce=${rec.nonce}; Path=/; SameSite=Strict${cookieSecureFlag(req)}`);
}
function ctlNonceValid(req) {
  const rec = req.ctlSid ? ctlSessions.get(req.ctlSid) : null;
  if (!rec || rec.expires <= Date.now()) return false;
  if (!(Date.now() - (rec.nonceAt ?? 0) <= CTL_NONCE_TTL_MS)) return false;
  const cookieNonce = cookieValue(req, 'ctl_nonce');
  const headerNonce = String(req.headers['x-ctl-nonce'] ?? '');
  return Boolean(cookieNonce && headerNonce)
    && tokenMatches(cookieNonce, rec.nonce)
    && tokenMatches(headerNonce, rec.nonce);
}

const healthStatus = ({ saveError, tickError }) => saveError || tickError ? 503 : 200;

async function handle(req, res) {
  // SEC5-01：先签发/续期服务端会话；nonce 只从服务端记录派生，绝不采信客户端自选值。
  if (req.method !== 'HEAD') issueCtlSession(req, res);
  // H-01：new URL 在旧版位于 try 之外。一条 `GET http://[ HTTP/1.1` 就会抛 ERR_INVALID_URL，
  // 变成未捕获 rejection ⇒ 进程 exit 1（已复现）。这里先兜住，任何解析失败一律 400。
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return json(res, 400, { error: 'BAD_URL' });
  }
  const p = url.pathname;
  // H-29：HEAD 探活（平台/监控常用）。放在 touch 之前——HEAD 不该被算成"有观众"，
  // 否则一个 30 秒一次的 uptime 探针就能把 watching 顶成恒真。
  if (req.method === 'HEAD') {
    if (p === '/' || p === '/index.html' || p === '/world' || p === '/healthz') {
      const status = p === '/healthz' ? healthStatus(host.status()) : 200;
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end();
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  // H-03：观众在场打点只认**读**路径。/act、/ctl 是写路由——让它们自己 touch 自己，
  // 等于任何人都能用一条 POST 把 watching 顶成 true 并烧真模型额度（实测 4 条 say 烧完 5 次调用）。
  // /healthz 也不算（平台探活会让"有观众"恒真）。/chat 同理。
    // 名字存档：公开列表只投影六项；进场是写路由（同源/令牌守卫）。
  if (p === '/saves' && req.method === 'GET') return json(res, 200, { entries: listCamps() });
  if (p === '/saves/back' && req.method === 'POST') {
    const denied = interactionDenied(req, CTL_TOKEN);
    if (denied) return json(res, 403, { error: denied });
    const back = await backToMainCamp();
    res.appendHeader('set-cookie', `camp=; Path=/; Max-Age=0; ${campCookieScope(req)}`);
    return json(res, 200, back);
  }
  if (p === '/saves/open' && req.method === 'POST') {
    const denied = interactionDenied(req, CTL_TOKEN);
    if (denied) return json(res, 403, { error: denied });
    if (listCamps().length >= CAMP_TOTAL_MAX) return json(res, 429, { error: 'CAMP_LIMIT' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'BAD_JSON' }); }
    // 限速按**营地名**分桶（反代下 IP 恒等，见上方注释）+ 一层全局桶 + 会话配额。
    // SEC5-04：会话配额是“同一个浏览器最多占几个营地”的可用性闸；脚本仍可换会话，但不再是 50 次零成本占满。
    if (!openAllowed(openBucketKey(body?.name), OPEN_LIMIT)
      || !openAllowed('g:open', OPEN_LIMIT_GLOBAL)
      || !openAllowed(`s:${req.ctlSid ?? 'anon'}`, OPEN_SESSION_LIMIT)) {
      return json(res, 429, { error: 'RATE_LIMITED' });
    }
    const opened = await openCamp(body?.name);
    if (!opened.ok) return json(res,['CAMP_UNAVAILABLE','SAVE_FAILED'].includes(opened.code)?503:400,{error:opened.code});
    // SEC3-02 / SEC5-05：创建者拿 camp_owner（HttpOnly）；索引只存 sha256。
    // 已有 owner 的营地绝不换绑：非 owner 重开不签发新 cookie，明确 403 CAMP_OWNED。
    const presented = cookieValue(req, 'camp_owner');
    const ownerToken = presented || randomBytes(16).toString('hex');
    let claim;
    try { claim = host.claimCamp(opened.key, ownerHashOf(ownerToken)); }
    catch { return json(res, 503, { error: 'SAVE_FAILED' }); }
    if (!claim.ok) return json(res, 503, { error: claim.code === 'NO_CAMP' ? 'SAVE_FAILED' : claim.code });
    if (!claim.owned) return json(res, 403, { error: 'CAMP_OWNED' });
    res.appendHeader('set-cookie', `camp=${opened.key}; Path=/; Max-Age=2592000; ${campCookieScope(req)}`);
    res.appendHeader('set-cookie', `camp_owner=${ownerToken}; Path=/; Max-Age=2592000; HttpOnly; ${campCookieScope(req)}`);
    return json(res, 200, opened);
  }
if (req.method === 'GET' && (p === '/' || p === '/index.html')) host.touch('entry');
  // 诊断（只读）：创空间网关会改写 Host，"真实浏览器访客能不能过写路由守卫"只能在线上量，
  // 不能靠本地推断——这条坑过一次：本地全绿，线上所有交互 403。
  // 纪律同 H-16：只回显判定结果，不回显地址原值、query、Cookie、令牌与供应商端点。
  if (req.method === 'GET' && p === '/diag') {
    const h = req.headers;
    const oh = (() => { try { return new URL(String(h.origin ?? '')).host.toLowerCase(); } catch { return ''; } })();
    const strip = (v) => String(v ?? '').trim().toLowerCase().replace(/:(80|443)$/, '');
    const eq = (a, b) => Boolean(a) && Boolean(b) && strip(a) === strip(b);
    const dryRun = mutatingDenied({ headers: { ...h, 'content-type': 'application/json' }, socket: req.socket }, CTL_TOKEN);
    return json(res, 200, {
      secFetchSite: h['sec-fetch-site'] ?? null,
      originPresent: Boolean(oh),
      originMatchesHost: eq(oh, h.host),
      originMatchesForwardedHost: eq(oh, String(h['x-forwarded-host'] ?? '').split(',').pop()),
      writeRouteVerdict: dryRun ?? 'PASS',
      note: '只回显判定结果，不回显地址、query、Cookie 与令牌',
    });
  }
  const viewMode = url.searchParams.get('mode');
  const campKey = url.searchParams.get('camp') ??
    (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('camp='))?.slice(5);

  if (req.method === 'GET' && p === '/healthz') {
    const st = host.status();
    // H-16：不再回显每个供应商的完整 base URL 与 DATA_DIR 绝对路径（实测曾回显内网地址）。
    const status = healthStatus(st);
    return json(res, status, {
      ok: status === 200,
      model: MODEL,
      providers: PROVIDERS.map((_b, i) => ({ configured: Boolean(providerKey(i)), model: MODELS[i] || MODEL })),
      relay: RELAY_TOKEN ? { ...brainRelay.view(), limits: brainRelay.limits } : { off: true },
      engine: 'life-architecture',
      listen: `${HOST}:${PORT}`,
      world: st,
      note: '不回显密钥、端点与数据目录',
    });
  }

  // 阶段 5：A/B 只读回放（range 或单刻）。历史浏览不写任何世界。
  if (req.method === 'GET' && p === '/replay') {
    const q = url.searchParams;
    const num = (k) => (q.has(k) ? Number(q.get(k)) : undefined);
    const out = host.replay({ from: num('from'), to: num('to'), t: num('t'), revision: num('rev') });
    return json(res, out.code === 'REPLAY_STALE' ? 409 : 200, out);
  }
  if (req.method === 'GET' && p === '/world') {
    // SEC5-02：非 MAIN 营地读路径必须 owner；不再“带了 cookie 才检查”。
    // 但“营地已经不在了”（平台重建清空 /data，名字档随之消失）不能继续报 403：那是“别人的营地”
    // 的语气，客户端只会当成网络故障无限重试成白屏。410 给它一个出口。
    if (campKey && campKey !== 'MAIN' && !ownerAllows(req, campKey)) return json(res, 403, { error: 'CAMP_NOT_OWNER' });
    try { return json(res,200,await host.readWorld(viewMode,campKey || undefined)); }
    catch (error) {
      if (error.code === 'CAMP_UNAVAILABLE') return json(res,503,{error:error.code});
      throw error;
    }
  }

  if (req.method === 'POST' && (p === '/act' || p === '/ctl')) {
    // H-30：读体失败要分清"超长"(413) 与"JSON 坏了"(400)。旧版把两者都包在同一个 catch 里 → 全变 400。
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (e) {
      if (e?.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'BODY_TOO_LARGE' });
      return json(res, 400, { error: 'BAD_JSON' });
    }
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(res, 400, { error: 'BAD_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'BAD_JSON' });
    // SEC3-01：普通交互（/act）配了令牌也允许同源浏览器；破坏性 /ctl 才要令牌（SEC3-02）。
    // SEC5-05：只有 MAIN 的 survival_reset 允许“服务端会话 nonce”作为令牌姿态下的浏览器授权；
    // 全局 reset / 具名营地仍只认 Bearer 或 owner（nonce 不越权）。
    const isMainCamp = !campKey || campKey === 'MAIN';
    const allowNonce = p === '/ctl' && body?.action === 'survival_reset' && isMainCamp;
    const denied = p === '/act'
      ? interactionDenied(req, CTL_TOKEN)
      : ctlDenied(req, body, CTL_TOKEN, () => ctlNonceValid(req), { allowNonce });
    if (denied) return json(res, p === '/ctl' ? 403 : (denied === 'UNAUTHORIZED' ? 401 : 403), { error: denied });
    // nonce 一次性：任何“靠 nonce 放行”的破坏性动作成功后立即轮换（响应里带回新 cookie）。
    const tokenAuthorized = Boolean(CTL_TOKEN) && tokenMatches(bearerOf(req), CTL_TOKEN);
    const nonceAuthorized = !tokenAuthorized && p === '/ctl'
      && DESTRUCTIVE_CTL.includes(String(body?.action ?? '')) && ctlNonceValid(req);
    if (nonceAuthorized) consumeCtlNonce(req, res);
    if (campKey && !ownerAllows(req, campKey) && !(p === '/ctl' && body?.action === 'survival_reset')) {
      return json(res, 403, { error: 'CAMP_NOT_OWNER' });
    }
    // H-02c：reset 是唯一会把整段历史丢掉的动作，必须显式确认，避免误点与 CSRF 成功。
    if (p === '/ctl' && ['reset', 'compare_reset', 'survival_reset'].includes(body?.action) && body?.confirm !== true) {
      return json(res, 400, { error: 'RESET_NEEDS_CONFIRM', note: '重置世界需要 confirm: true' });
    }
    // SEC3-02：营地归属。survival_reset 只有 owner cookie 或 CTL_TOKEN 能做；旧营地没 owner 的不得匿名重置。
    // SEC5-05：MAIN 没有 ownerHash，令牌姿态下由上面的 allowNonce 分支授权；未设令牌时同样由 nonce 授权。
    if (p === '/ctl' && body?.action === 'survival_reset') {
      const tokenOk = Boolean(CTL_TOKEN) && tokenMatches(bearerOf(req), CTL_TOKEN);
      const isMain = !campKey || campKey === 'MAIN';
      if (!tokenOk && !isMain) {
        const ownerToken = cookieValue(req, 'camp_owner');
        const ownerHash = host.campOwnerHash(campKey);
        if (!ownerHash || !ownerToken || ownerHashOf(ownerToken) !== ownerHash) {
          return json(res, 403, { error: 'CAMP_NOT_OWNER' });
        }
      }
    }
    // SEC5-05 约束：MAIN 重开加频率限制 + 审计事件，防止脚本拿着可获取的 nonce 反复重开。
    const mainReset = p === '/ctl' && body?.action === 'survival_reset' && isMainCamp;
    if (mainReset) {
      const now = Date.now();
      while (mainResetTimes.length && now - mainResetTimes[0] >= MAIN_RESET_WINDOW_MS) mainResetTimes.shift();
      if (mainResetTimes.length >= MAIN_RESET_LIMIT) {
        auditMainReset(req, 'rate_limited');
        return json(res, 429, { error: 'RESET_RATE_LIMITED' });
      }
      mainResetTimes.push(now);
    }
    try {
      const out = await (p==='/act' ? host.act(body,campKey || undefined) : host.ctl(body,campKey || undefined));
      if (mainReset) auditMainReset(req, out?.ok ? 'ok' : (out?.error ?? 'rejected'));
      return json(res,200,out);
    } catch (error) {
      if (mainReset) auditMainReset(req, error?.code ?? 'error');
      if (error.code === 'CAMP_UNAVAILABLE') return json(res,503,{error:error.code});
      throw error;
    }
  }

  // BUG-8：鉴权 → 与 modelBrain 同一套预算/在场闸门 → 才转发。
  // 引擎侧入口：请求体原样转给节点，这层绝不解释内容；响应拼成 OpenAI 形状给 host.postChat 读。
  if (req.method === 'POST' && p === '/brain/v1/chat/completions') {
    if (!RELAY_TOKEN) return json(res, 404, { error: 'NOT_FOUND' });
    if (!engineAuthorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    const parsed = await readJsonBody(req);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return json(res, 400, { error: 'BAD_JSON' });
    const job = brainRelay.submit(parsed.value);
    if (!job) return json(res, 503, { error: 'RELAY_BUSY' }); // 队列满：让引擎立刻退回下一个供应商，不排队堆积
    const r = await job.promise;
    if (!r.ok) return json(res, r.code === 'RELAY_TIMEOUT' ? 504 : 502, { error: String(r.code ?? 'RELAY_FAILED') });
    return json(res, 200, {
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: String(r.content ?? '') }, finish_reason: String(r.finish_reason ?? 'stop') }],
      usage: r.usage && typeof r.usage === 'object' ? r.usage : {}
    });
  }
  if (req.method !== 'GET' && (p === '/brain/claim' || p === '/brain/result' || p === '/brain/stats')) {
    if (!RELAY_TOKEN) return json(res, 404, { error: 'NOT_FOUND' });
    if (!relayAuthorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    if (p === '/brain/claim') {
      const job = brainRelay.claim();
      if (!job) { res.writeHead(204, { ...SECURITY_HEADERS }); return res.end(); }
      return json(res, 200, job);
    }
    if (p === '/brain/stats') return json(res, 200, brainRelay.view());
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return json(res, 400, { error: 'BAD_JSON' });
    const b = parsed.value ?? {};
    const done = brainRelay.complete(String(b.id ?? ''), b.ok === false
      ? { ok: false, code: String(b.code ?? 'AGENT_FAILED') }
      : { content: b.content, usage: b.usage, finish_reason: b.finish_reason });
    return json(res, done ? 200 : 409, { ok: done }); // 409＝活已超时或不属于这里，agent 不必重试
  }

  if (req.method === 'POST' && p === '/chat') {
    if (!CHAT_TOKEN) return json(res, 404, { error: 'NOT_FOUND' }); // 默认关闭
    if (!chatAuthorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    if (!isJson(req.headers['content-type'])) return json(res, 415, { error: 'NEED_JSON' });
    const gate = modelGate();
    if (gate) return json(res, gate === 'BUDGET' ? 429 : 503, { error: gate });
    return chatProxy(req, res);
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return serveStatic(req, res, p === '/' ? '/web/index.html' : p, url.search);
}

const server = createServer((req, res) => {
  // H-01：handler 全程兜住。之前 new URL 在 try 外，畸形请求会把进程打死。
  handle(req, res).catch((e) => {
    try {
      if (!res.headersSent) {
        // H-30：超长 body 映射成 413（不是 400），且不在 note 里回显内部错误串
        if (e?.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'BODY_TOO_LARGE' });
        return json(res, 400, { error: 'BAD_REQUEST', note: String(e?.message ?? e).slice(0, 160) });
      }
      res.end();
    } catch { /* 连接已断 */ }
  });
});

// H-34：端口被占时给出可读的错误并退出（而不是裸栈崩溃）。平台会按重启策略拉起。
server.on('error', (e) => {
  console.error('[serve] server error:', e?.code ?? '', e?.message ?? e);
  if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') process.exit(1);
});

// 兜底：任何漏网的 rejection 都不许杀进程。世界在服务器上，进程死了演示就停摆。
// 只记一行 stderr，不静默吞掉（运维要能在日志里看见）。
process.on('unhandledRejection', (e) => { console.error('[serve] unhandledRejection:', e?.message ?? e); });
process.on('uncaughtException', (e) => { console.error('[serve] uncaughtException:', e?.message ?? e); });

const DELIBERATION_MODEL = (process.env.DELIBERATION_MODEL ?? '').trim();
host.setBackend({ providers: PROVIDERS, keys: KEYS, model: MODEL, models: MODELS, deliberationModel: DELIBERATION_MODEL, brain: process.env.BRAIN ?? 'local' });
if (DELIBERATION_MODEL) console.error(`[serve] 审议车道指到 ${DELIBERATION_MODEL}（只在只花电的节点路上生效；节点 agent 需要 UPSTREAM_MAP 里有这个名字）`);
// PRESENCE_MS 的单位是**毫秒**（host.mjs 默认 180000）。内部部署记录曾写"设 45~60 秒"，
// 实际配成 PRESENCE_MS=60 ⇒ 在场窗口只有 60 毫秒 ⇒ 页面每 900ms 轮询、tick 每 6000ms，
// observerActive 几乎恒假 ⇒ 真模型实际上从未被调用过。不擅自改语义（可能真有人要 60ms），
// 但必须显式警告，否则这个坑会一直静默存在。
{
  const presenceMs = Number(process.env.PRESENCE_MS ?? 180000);
  if (Number.isFinite(presenceMs) && presenceMs < 1000) {
    console.error(`[serve] 警告：PRESENCE_MS=${presenceMs} 的单位是毫秒，在场窗口只有 ${presenceMs} ms。若本意是 ${presenceMs} 秒，应设为 ${presenceMs * 1000}。`);
  }
}
// 播报归应用层：host 是库，往 stdout 写日志会干扰测试 runner 的消息通道
const boot = await host.start();
// 决策口径（所有者 2026-11-16）：生产不设 CTL_TOKEN。这条警告必须排在"就绪"之前，便于启动日志与测试都看得到。
if (CTL_TOKEN) console.error('[serve] 提示：CTL_TOKEN 已配置 ⇒ /ctl 的破坏性动作（reset/survival_reset/catchup/brain）只认 Bearer 令牌；/act 与 /saves/open 仍允许同源浏览器，不会被锁死。');
console.log(boot.note);
server.listen(PORT, HOST, () => {
  console.log(`life-demo 就绪 http://${HOST}:${PORT}  模型转发=${PROVIDERS.length ? PROVIDERS.length + ' 档' : '关（无端点则世界走本地替身）'}  存档=${boot.dir}`);
});










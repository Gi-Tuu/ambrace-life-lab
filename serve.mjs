// 零依赖静态 + 转发 + 权威世界宿主。
// 为什么世界状态必须在服务端：内部状态「持续存在」是这套架构的主张本身。
// 放在浏览器里，关标签页就重置；魔搭免费创空间还会休眠 —— 两者都会当面打脸这个主张。
// 密钥只留在服务端进程，绝不进前端、公开源码或构建产物。
import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { extname, join, sep, resolve } from 'node:path';
import { host, modelGate, modelCharged, modelRelease } from './life/host.mjs';

const ROOT = resolve('.');
// 魔搭创空间 Docker 约定监听 0.0.0.0:7860
const PORT = Number(process.env.PORT ?? 7860);
const HOST = process.env.HOST ?? '0.0.0.0';
// 供应商可替换：主端点失败按顺序退到下一个（魔搭 API-Inference 优先，第三方兜底）
const PROVIDERS = (process.env.MODEL_PROVIDERS ?? process.env.MODEL_BASE_URL ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const KEYS = (process.env.MODEL_KEYS ?? process.env.MODEL_KEY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MODEL = process.env.MODEL_NAME ?? '';
// 每家供应商的模型 id 前缀可能不同（魔搭 deepseek-ai/ vs 第三方 deepseek/）：按位对应，缺位退回 MODEL
const MODELS = (process.env.MODEL_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
  '.txt': 'text/plain; charset=utf-8',
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type });
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
// 镜像里静态资源只有 web/ 一样（Dockerfile 只 COPY 四样），所以只放行 web/ 就够了。
const STATIC_BASE = join(ROOT, 'web');

async function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(String(urlPath)); } catch { return json(res, 400, { error: 'BAD_PATH' }); }
  if (rel === '/index.html') rel = '/web/index.html';
  if (!rel.startsWith('/web/')) return json(res, 404, { error: 'NOT_FOUND' });
  const target = resolve(ROOT, '.' + rel);
  let real, base;
  try {
    [real, base] = await Promise.all([realpath(target), realpath(STATIC_BASE)]);
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
    res.writeHead(200, { 'content-type': MIME[extname(real)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
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

// ─────────────────── 请求守卫（第二次审计 H-01 / H-02 / H-03）───────────────────
// H-02：/ctl 与 /act 原先无鉴权、不校验 content-type 与来源。跨站页面用 text/plain 的
// "simple request"（不触发 preflight）就能 POST {"action":"reset"} 把唯一历史档抹掉。
// 这里三道一起上：必须是 JSON、必须同源、配了 CTL_TOKEN 还必须有令牌。
const CTL_TOKEN = process.env.CTL_TOKEN ?? '';

const isJson = (h) => String(h ?? '').toLowerCase().startsWith('application/json');

// 同源判定：sec-fetch-site 明确 cross-site 一律拒；带 Origin 时必须与 Host 一致。
// 浏览器之外的客户端（脚本/健康检查）没有 Origin，放行——它们本来就无法被 CSRF。
function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    const host = String(req.headers.host ?? '').toLowerCase();
    return o.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

// 定长比较：避免用长度或前缀差异做旁路探测
function tokenMatches(given, expected) {
  if (!expected) return false;
  const g = String(given ?? '');
  if (g.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < g.length; i += 1) diff |= g.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const bearerOf = (req) => {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-ctl-token'] ?? '');
};

// 写路由的统一闸门。返回 null 表示放行，否则返回拒因字符串。
function mutatingDenied(req) {
  if (!isJson(req.headers['content-type'])) return 'NEED_JSON';
  if (!sameOrigin(req)) return 'CROSS_SITE';
  if (CTL_TOKEN && !tokenMatches(bearerOf(req), CTL_TOKEN)) return 'UNAUTHORIZED';
  return null;
}

async function chatProxy(req, res) {
  if (!PROVIDERS.length || !KEYS.some(Boolean)) return json(res, 503, { error: 'NO_BACKEND', note: '未配置模型端点，世界自动退回本地替身' });
  const body = JSON.parse(await readBody(req));
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 8) : [];
  const attempts = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), UP_TIMEOUT_MS);
    try {
      const up = await fetch(`${PROVIDERS[i]}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS[i] ?? KEYS[0]}` },
        body: JSON.stringify({ model: MODELS[i] ?? MODEL, temperature: Math.min(1.2, Math.max(0, Number(body.temperature) || 0.85)), messages, response_format: { type: 'json_object' }, max_tokens: 120 }),
        signal: ac.signal,
      });
      const text = await up.text();
      if (!up.ok) { attempts.push(`${PROVIDERS[i].replace(/^https:\/\//, '')} → HTTP ${up.status}`); continue; }
      const j = JSON.parse(text);
      modelCharged(j.usage?.total_tokens ?? 0); // 预扣转正式消费（calls 已在 gate 里扣过）
      // 只回内容和用量：不透传上游原始响应，也不回端点/尝试明细（那等于告诉对方配了哪些供应商）
      return json(res, 200, { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {} });
    } catch (e) {
      attempts.push(`${PROVIDERS[i].replace(/^https:\/\//, '')} → ${String(e.message).slice(0, 50)}`);
    } finally {
      clearTimeout(to);
    }
  }
  modelRelease(); // H-04：全供应商失败 ⇒ 把 gate 预扣的额度退回去，不能白吃
  return json(res, 502, { error: 'ALL_PROVIDERS_FAILED', tries: attempts.length });
}

async function handle(req, res) {
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end();
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  // H-03：观众在场打点只认**读**路径。/act、/ctl 是写路由——让它们自己 touch 自己，
  // 等于任何人都能用一条 POST 把 watching 顶成 true 并烧真模型额度（实测 4 条 say 烧完 5 次调用）。
  // /healthz 也不算（平台探活会让"有观众"恒真）。/chat 同理。
  if (p === '/' || p === '/index.html' || p === '/world') host.touch();

  if (req.method === 'GET' && p === '/healthz') {
    const st = host.status();
    // H-16：不再回显每个供应商的完整 base URL 与 DATA_DIR 绝对路径（实测曾回显内网地址）。
    return json(res, 200, {
      ok: !st.saveError && !st.tickError, // 存档失败或 tick 抛错时探活必须是红的，否则平台重启策略形同虚设
      model: MODEL,
      providers: PROVIDERS.map((_b, i) => ({ configured: Boolean(KEYS[i] ?? KEYS[0]), model: MODELS[i] ?? MODEL })),
      engine: 'life-architecture',
      listen: `${HOST}:${PORT}`,
      world: st,
      note: '不回显密钥、端点与数据目录',
    });
  }

  if (req.method === 'GET' && p === '/world') return json(res, 200, host.snapshot());

  if (req.method === 'POST' && (p === '/act' || p === '/ctl')) {
    const denied = mutatingDenied(req);
    if (denied) return json(res, denied === 'UNAUTHORIZED' ? 401 : 403, { error: denied });
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
    // H-02c：reset 是唯一会把整段历史丢掉的动作，必须显式确认，避免误点与 CSRF 成功。
    if (p === '/ctl' && body?.action === 'reset' && body?.confirm !== true) {
      return json(res, 400, { error: 'RESET_NEEDS_CONFIRM', note: '重置世界需要 {"action":"reset","confirm":true}' });
    }
    return json(res, 200, await (p === '/act' ? host.act(body) : host.ctl(body)));
  }

  // BUG-8：鉴权 → 与 modelBrain 同一套预算/在场闸门 → 才转发。
  if (req.method === 'POST' && p === '/chat') {
    if (!CHAT_TOKEN) return json(res, 404, { error: 'NOT_FOUND' }); // 默认关闭
    if (!chatAuthorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    if (!isJson(req.headers['content-type'])) return json(res, 415, { error: 'NEED_JSON' });
    const gate = modelGate();
    if (gate) return json(res, gate === 'BUDGET' ? 429 : 503, { error: gate });
    return chatProxy(req, res);
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return serveStatic(res, p === '/' ? '/web/index.html' : p);
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

host.setBackend({ providers: PROVIDERS, keys: KEYS, model: MODEL, models: MODELS, brain: process.env.BRAIN ?? 'local' });
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
console.log(boot.note);
server.listen(PORT, HOST, () => {
  console.log(`life-demo 就绪 http://${HOST}:${PORT}  模型转发=${PROVIDERS.length ? PROVIDERS.length + ' 档' : '关（无端点则世界走本地替身）'}  存档=${boot.dir}`);
});

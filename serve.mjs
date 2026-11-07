// 零依赖静态 + 转发 + 权威世界宿主。
// 为什么世界状态必须在服务端：内部状态「持续存在」是这套架构的主张本身。
// 放在浏览器里，关标签页就重置；魔搭免费创空间还会休眠 —— 两者都会当面打脸这个主张。
// 密钥只留在服务端进程，绝不进前端、公开源码或构建产物。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';
import { host } from './life/host.mjs';

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
    if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const target = resolve(ROOT, rel || 'web/index.html');
  // 目录穿越防护：解析后的路径必须仍在项目根内
  if (!target.startsWith(ROOT)) return json(res, 403, { error: 'FORBIDDEN' });
  if (rel.startsWith('.env') || rel.startsWith('data') || rel.includes('node_modules')) return json(res, 404, { error: 'NOT_FOUND' });
  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(res, `${rel.replace(/\/$/, '')}/index.html`);
    const buf = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'NOT_FOUND', path: rel });
  }
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
      // 只回内容和用量，不透传上游原始响应
      return json(res, 200, { content: j.choices?.[0]?.message?.content ?? '', usage: j.usage ?? {}, via: PROVIDERS[i], attempts });
    } catch (e) {
      attempts.push(`${PROVIDERS[i].replace(/^https:\/\//, '')} → ${String(e.message).slice(0, 50)}`);
    } finally {
      clearTimeout(to);
    }
  }
  return json(res, 502, { error: 'ALL_PROVIDERS_FAILED', attempts });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') {
      return json(res, 200, {
        ok: true,
        model: MODEL,
        providers: PROVIDERS.map((b, i) => ({ base: b, key: Boolean(KEYS[i] ?? KEYS[0]), model: MODELS[i] ?? MODEL })),
        engine: 'life-architecture',
        listen: `${HOST}:${PORT}`,
        dataDir: process.env.DATA_DIR ?? 'data',
        world: host.status(),
        note: '只报有没有配密钥，不回显密钥',
      });
    }

    if (req.method === 'GET' && p === '/world') return json(res, 200, host.snapshot());
    if (req.method === 'POST' && p === '/act') return json(res, 200, await host.act(JSON.parse(await readBody(req))));
    if (req.method === 'POST' && p === '/ctl') return json(res, 200, await host.ctl(JSON.parse(await readBody(req))));

    if (req.method === 'POST' && p === '/chat') return chatProxy(req, res);

    if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return serveStatic(res, p === '/' ? '/web/index.html' : p);
  } catch (e) {
    return json(res, 400, { error: 'BAD_REQUEST', note: String(e.message).slice(0, 160) });
  }
});

host.setBackend({ providers: PROVIDERS, keys: KEYS, model: MODEL, models: MODELS, brain: process.env.BRAIN ?? 'local' });
// 播报归应用层：host 是库，往 stdout 写日志会干扰测试 runner 的消息通道
const boot = await host.start();
console.log(boot.note);
server.listen(PORT, HOST, () => {
  console.log(`life-demo 就绪 http://${HOST}:${PORT}  模型转发=${PROVIDERS.length ? PROVIDERS.length + ' 档' : '关（无端点则世界走本地替身）'}  存档=${boot.dir}`);
});

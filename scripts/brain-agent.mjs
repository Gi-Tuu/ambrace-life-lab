// 大脑中继的节点侧执行器：出站去公开实例取活，交给本机 vLLM 跑，再把结果送回去。
// 全程只有**出站 HTTPS**——节点不监听任何公网端口，也不新增第三方隧道软件。
// 用法（节点上，建议 tmux）：
//   RELAY_URL=https://xxx.ms.show  RELAY_TOKEN=…  UPSTREAM_KEY=… node scripts/brain-agent.mjs
//   （UPSTREAM_KEY 可改用 UPSTREAM_KEY_FILE 指向只读文件；密钥不进命令行参数）
// 默认上游是节点自己的 vLLM：http://127.0.0.1:9026/v1。
import fs from 'node:fs';

const RELAY = String(process.env.RELAY_URL ?? '').replace(/\/+$/, '');
const readTokenFile = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const TOKEN = process.env.RELAY_TOKEN || (process.env.RELAY_TOKEN_FILE ? readTokenFile(process.env.RELAY_TOKEN_FILE) : '');
const UPSTREAM = String(process.env.UPSTREAM ?? 'http://127.0.0.1:9026/v1').replace(/\/+$/, '');
const UP_KEY = process.env.UPSTREAM_KEY || (process.env.UPSTREAM_KEY_FILE ? readTokenFile(process.env.UPSTREAM_KEY_FILE) : '');
const POLL_MS = Number(process.env.POLL_MS ?? 400) || 400;
const CLAIM_TIMEOUT_MS = Number(process.env.CLAIM_TIMEOUT_MS ?? 8000) || 8000;
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 20000) || 20000;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// 私有创空间对匿名请求直接 403（魔搭网关拦的，进不到我们的路由），所以要带上 ?studio_token=…；
// 那是会话令牌、会过期，翻公开之后这一项就该留空。
const QS = String(process.env.RELAY_QUERY ?? '').replace(/^[?&]+/, '');
const api = (path) => RELAY + path + (QS ? `${path.includes('?') ? '&' : '?'}${QS}` : '');
if (!RELAY || !TOKEN) {
  console.error('缺 RELAY_URL / RELAY_TOKEN：中继端点默认关闭，不给令牌就不该起来。');
  process.exit(2);
}

let stopping = false;
let backoff = POLL_MS;
process.on('SIGINT', () => { stopping = true; log('收到 SIGINT，跑完手上这条就退出'); });
process.on('SIGTERM', () => { stopping = true; log('收到 SIGTERM，跑完手上这条就退出'); });

const post = async (path, body, ms, auth) => fetch(api(path), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(ms)
});

const report = async (payload) => {
  try {
    const r = await post('/brain/result', payload, CLAIM_TIMEOUT_MS, true);
    if (r.status === 409) log(`  └ 结果被拒（活已超时或不属于本队列）id=${payload.id}`);
  } catch (e) {
    log(`  └ 送回失败 ${String(e?.message).slice(0, 60)}（等待方已按超时处理，不重试）`);
  }
};

log(`大脑中继就绪 relay=${RELAY.replace(/^https?:\/\//, '')} 上游=${UPSTREAM.replace(/^https?:\/\//, '')} 轮询=${POLL_MS}ms 令牌=${TOKEN ? '有' : '无'}`);

while (!stopping) {
  let job = null;
  try {
    const r = await post('/brain/claim', {}, CLAIM_TIMEOUT_MS, true);
    backoff = POLL_MS;
    if (r.status === 204) { await new Promise((res) => setTimeout(res, backoff)); continue; }
    if (!r.ok) { log(`取活 HTTP ${r.status} ${JSON.stringify(await r.text()).slice(0, 80)}`); continue; }
    job = await r.json();
  } catch (e) {
    backoff = Math.min(10000, backoff * 2);
    log(`取活异常 ${String(e?.message ?? e).slice(0, 60)} · ${backoff}ms 后重试`);
    await new Promise((res) => setTimeout(res, backoff));
    continue;
  }
  if (!job?.id) continue;

  const t0 = Date.now();
  try {
    const up = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(UP_KEY ? { authorization: `Bearer ${UP_KEY}` } : {}) },
      body: JSON.stringify(job.body ?? {}),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS)
    });
    const text = await up.text();
    if (!up.ok) {
      log(`跑挂 model=${job.body?.model} 排队=${job.waitedMs}ms HTTP=${up.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
      await report({ id: job.id, ok: false, code: `UPSTREAM_${up.status}` });
      continue;
    }
    const j = JSON.parse(text);
    const content = j?.choices?.[0]?.message?.content ?? '';
    log(`跑了 model=${job.body?.model} 排队=${job.waitedMs}ms 用时=${Date.now() - t0}ms 正文=${String(content).length}字 tokens=${j?.usage?.total_tokens ?? '?'}`);
    await report({ id: job.id, content, usage: j?.usage ?? {}, finish_reason: j?.choices?.[0]?.finish_reason ?? 'stop' });
  } catch (e) {
    log(`上游异常 model=${job.body?.model} ${String(e?.name ?? e)} ${String(e?.message).slice(0, 60)}`);
    await report({ id: job.id, ok: false, code: 'UPSTREAM_ERROR' });
  }
}
log('已退出（手上无未交的活；队列侧会按超时自行结算）');
process.exitCode = 0;

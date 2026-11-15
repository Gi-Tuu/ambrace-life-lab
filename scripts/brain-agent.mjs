// 大脑中继的节点侧执行器：出站去公开实例取活，交给本机 vLLM 跑，再把结果送回去。
// 全程只有**出站 HTTPS**——节点不监听任何公网端口，也不新增第三方隧道软件。
// 用法（节点上）：RELAY_URL=https://xxx.ms.show  RELAY_TOKEN_FILE=~/.relay_token  UPSTREAM_KEY_FILE=~/.vllm_key \
//   node scripts/brain-agent.mjs
// 默认上游是节点自己的 vLLM：http://127.0.0.1:9026/v1。密钥只从环境变量或 *KEY_FILE 读，不进命令行参数。
import fs from 'node:fs';

const RELAY = String(process.env.RELAY_URL ?? '').replace(/\/+$/, '');
const readTokenFile = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const TOKEN = process.env.RELAY_TOKEN || (process.env.RELAY_TOKEN_FILE ? readTokenFile(process.env.RELAY_TOKEN_FILE) : '');
const UPSTREAM = String(process.env.UPSTREAM ?? 'http://127.0.0.1:9026/v1').replace(/\/+$/, '');
const UP_KEY = process.env.UPSTREAM_KEY || (process.env.UPSTREAM_KEY_FILE ? readTokenFile(process.env.UPSTREAM_KEY_FILE) : '');
const POLL_MS = Number(process.env.POLL_MS ?? 400) || 400;
const CLAIM_TIMEOUT_MS = Number(process.env.CLAIM_TIMEOUT_MS ?? 8000) || 8000;
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 20000) || 20000;
// 一个拍里最多两发调用（MAX_CALLS_PER_TICK=2）：串行取活会让第二发干等、被整拍预算掐掉；
// 并发跑则由 vLLM 自己批处理。上限 4，免得把唯一的 GPU 压成队列。
const WORKERS = Math.max(1, Math.min(4, Number(process.env.CONCURRENCY ?? 2) || 2));
// 私有创空间的网关会先把匿名请求打成 403，所以要带 ?studio_token=…（会话令牌，会过期；翻公开后可去掉）。
// 鉴权同样以查询参数为主：实测魔搭网关会吃掉自定义鉴权头（Authorization / x-brain-token 都到不了容器）。
// 代价：这把令牌会出现在平台访问日志里——它与 studio_token 同级、可轮换，翻公开后应换成密文变量。
const QS = String(process.env.RELAY_QUERY ?? '').replace(/^[?&]+/, '');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path) => `${RELAY}${path}?relay_token=${encodeURIComponent(TOKEN)}${QS ? `&${QS}` : ''}`;

if (!RELAY || !TOKEN) {
  console.error('缺 RELAY_URL / RELAY_TOKEN：中继端点默认关闭，不给令牌就不该起来。');
  process.exit(2);
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; log('收到 SIGINT，跑完手上的活就退出'); });
process.on('SIGTERM', () => { stopping = true; log('收到 SIGTERM，跑完手上的活就退出'); });

const post = (path, body, ms) => fetch(api(path), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body ?? {}),
  signal: AbortSignal.timeout(ms)
});

async function report(payload) {
  try {
    const r = await post('/brain/result', payload, CLAIM_TIMEOUT_MS);
    if (r.status === 409) log(`  └ 结果被拒（活已超时或不属于本队列）id=${payload.id}`);
  } catch (e) {
    log(`  └ 送回失败 ${String(e?.message).slice(0, 60)}（等待方已按超时处理，不重试）`);
  }
}

async function runJob(job) {
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
      return;
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

async function worker(id) {
  let backoff = POLL_MS;
  while (!stopping) {
    let job = null;
    try {
      const r = await post('/brain/claim', {}, CLAIM_TIMEOUT_MS);
      backoff = POLL_MS;
      if (r.status === 204) { await sleep(backoff); continue; }
      if (!r.ok) { log(`[${id}] 取活 HTTP ${r.status} ${(await r.text()).slice(0, 70)}`); await sleep(backoff); continue; }
      job = await r.json();
    } catch (e) {
      backoff = Math.min(10000, backoff * 2);
      log(`[${id}] 取活异常 ${String(e?.message ?? e).slice(0, 60)} · ${backoff}ms 后重试`);
      await sleep(backoff);
      continue;
    }
    if (job?.id) await runJob(job);
  }
}

log(`大脑中继就绪 并发=${WORKERS} 通道 relay=${RELAY.replace(/^https?:\/\//, '')} 上游=${UPSTREAM.replace(/^https?:\/\//, '')} 轮询=${POLL_MS}ms`);
await Promise.all(Array.from({ length: WORKERS }, (_x, i) => worker(i + 1)));
log('已退出（手上无未交的活；队列侧会按超时自行结算）');

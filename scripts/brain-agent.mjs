// 大脑中继的节点侧执行器：出站去公开实例取活，交给本机 vLLM 跑，再把结果送回去。
// 全程只有**出站 HTTPS**——节点不监听任何公网端口，也不新增第三方隧道软件。
// 用法（节点上）：RELAY_URL=https://xxx.ms.show  RELAY_TOKEN_FILE=~/.relay_token  UPSTREAM_KEY_FILE=~/.vllm_key \
//   node scripts/brain-agent.mjs
// 默认上游是节点自己的 vLLM：http://127.0.0.1:9026/v1。密钥只从环境变量或 *KEY_FILE 读，不进命令行参数。
import fs from 'node:fs';

const readTokenFile = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };

// DM-3′：一条中继通道可以喂多台引擎，按请求体里的 model 名字分流。
// 审议车道实测挪到另一台引擎能把"跑完才发现没人等"的比例从 38% 打到 2%（docs/PLAN.md §87），
// 而对话必须继续留在主脑上：那台备用引擎只被验证过会选 id，没被验证过会说话。
export function parseUpstreamMap(spec) {
  const out = {};
  for (const chunk of String(spec ?? '').split(/[,;]/)) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    const name = chunk.slice(0, i).trim();
    const url = chunk.slice(i + 1).trim().replace(/\/+$/, '');
    if (name && url) out[name] = url;
  }
  return out;
}

// 未知模型名一律回落默认上游：宁可问错引擎，也不要因为映射写错就整条链路罢工。
export function upstreamFor(model, base, map) {
  const key = String(model ?? '').trim();
  return (map && Object.prototype.hasOwnProperty.call(map, key) && map[key]) || base;
}

export async function run({ env = process.env } = {}) {
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RELAY = String(env.RELAY_URL ?? '').replace(/\/+$/, '');
  const TOKEN = env.RELAY_TOKEN || (env.RELAY_TOKEN_FILE ? readTokenFile(env.RELAY_TOKEN_FILE) : '');
  const UPSTREAM = String(env.UPSTREAM ?? 'http://127.0.0.1:9026/v1').replace(/\/+$/, '');
  const UP_KEY = env.UPSTREAM_KEY || (env.UPSTREAM_KEY_FILE ? readTokenFile(env.UPSTREAM_KEY_FILE) : '');
  const LANES = parseUpstreamMap(env.UPSTREAM_MAP ?? '');
  const POLL_MS = Number(env.POLL_MS ?? 400) || 400;
  const CLAIM_TIMEOUT_MS = Number(env.CLAIM_TIMEOUT_MS ?? 8000) || 8000;
  const RUN_TIMEOUT_MS = Number(env.RUN_TIMEOUT_MS ?? 20000) || 20000;
  // 一个拍里最多两发调用（MAX_CALLS_PER_TICK=2）：串行取活会让第二发干等、被整拍预算掐掉；
  // 并发跑则由 vLLM 自己批处理。上限 4，免得把唯一的 GPU 压成队列。
  const WORKERS = Math.max(1, Math.min(4, Number(env.CONCURRENCY ?? 2) || 2));
  // 私有创空间的网关会先把匿名请求打成 403，所以要带 ?studio_token=…（会话令牌，会过期；翻公开后可去掉）。
  // 鉴权同样以查询参数为主：实测魔搭网关会吃掉自定义鉴权头（Authorization / x-brain-token 都到不了容器）。
  // 代价：这把令牌会出现在平台访问日志里——它与 studio_token 同级、可轮换，翻公开后应换成密文变量。
  const QS = String(env.RELAY_QUERY ?? '').replace(/^[?&]+/, '');
  const api = (path) => `${RELAY}${path}?relay_token=${encodeURIComponent(TOKEN)}${QS ? `&${QS}` : ''}`;

  if (!RELAY || !TOKEN) {
    log('缺 RELAY_URL / RELAY_TOKEN：中继端点默认关闭，不给令牌就不该起来。');
    return 2;
  }

  let stopping = false;
  const halt = () => { stopping = true; log('收到停止信号，跑完手上的活就退出'); };
  process.on('SIGINT', halt);
  process.on('SIGTERM', halt);

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
    const upBase = upstreamFor(job.body?.model, UPSTREAM, LANES);
    const lane = upBase === UPSTREAM ? '' : ` 车道=${upBase.replace(/^https?:\/\//, '')}`;
    try {
      const up = await fetch(`${upBase}/chat/completions`, {
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
      log(`跑了 model=${job.body?.model} 排队=${job.waitedMs}ms 用时=${Date.now() - t0}ms 正文=${String(content).length}字 tokens=${j?.usage?.total_tokens ?? '?'}${lane}`);
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

  log(`大脑中继就绪 并发=${WORKERS} 通道=${RELAY.replace(/^https?:\/\//, '')} 上游=${UPSTREAM.replace(/^https?:\/\//, '')}`
    + ` 车道=${Object.keys(LANES).length ? Object.entries(LANES).map(([k, v]) => `${k}→${v.replace(/^https?:\/\//, '')}`).join(' ') : '（全部走默认上游）'}`
    + ` 轮询=${POLL_MS}ms`);
  await Promise.all(Array.from({ length: WORKERS }, (_x, i) => worker(i + 1)));
  log('已退出（手上无未交的活；队列侧会按超时自行结算）');
  return 0;
}

// 只有直接运行才起循环：被测试 import 时不能把闸门跑成一个退不出的服务。
if (process.argv[1]?.endsWith('brain-agent.mjs')) process.exitCode = await run();

// 魔搭托管推理选型探针：用你自己的 SDK token 逐个模型实测延迟与返回质量，不写盘、不回显密钥。
// 用法： MODELSCOPE_TOKEN=ms-xxxx node scripts/probe-model.mjs [模型id ...]
const TOKEN = process.env.MODELSCOPE_TOKEN || process.env.MODEL_KEY || '';
if (!TOKEN) {
  console.error('缺少密钥：MODELSCOPE_TOKEN=ms-xxxx node scripts/probe-model.mjs');
  process.exit(2);
}
const BASE = (process.env.PROBE_BASE || 'https://api-inference.modelscope.cn/v1').replace(/\/+$/, '');
const IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.5-27B', 'Qwen/Qwen3.5-35B-A3B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'];
// 和游戏里同形态的一句话：带内部状态，看它会不会把思考写进正文。
const PROMPT = '你是村子里的居民。当前：饥饿 0.7、疲惫 0.3、对你信任 0.2、今日采到 2 份石料。用一句口语回答玩家"你今天做了什么"，不超过 30 字，不要解释。';

const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

for (const id of IDS) {
  const times = [];
  let last = '';
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: id, messages: [{ role: 'user', content: PROMPT }], max_tokens: 80, temperature: 0.9,
          chat_template_kwargs: { enable_thinking: false }
        }),
        signal: AbortSignal.timeout(60000)
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      if (!res.ok) { last = `HTTP ${res.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`; times.push(ms); break; }
      const j = JSON.parse(text);
      const c = (j.choices?.[0]?.message?.content ?? '').trim();
      times.push(ms);
      last = c.replace(/\s+/g, ' ').slice(0, 46) + (c.length > 90 ? ' …含思考泄漏?' : '');
    } catch (e) {
      times.push(Date.now() - t0);
      last = '异常 ' + String(e?.name ?? e) + ' ' + String(e?.message ?? '').slice(0, 60);
      break;
    }
  }
  const p50 = pct(times, 0.5);
  const flag = p50 > 4000 ? '⚠ 超游戏单请求上限 MODEL_TIMEOUT_MS=4000' : '✓ 在 4s 预算内';
  console.log(`${id.padEnd(38)} P50 ${String(p50).padStart(5)}ms  n=${times.length}  ${flag}`);
  console.log(`${''.padEnd(38)} └ ${last}`);
}
console.log('\n注：单日调用配额与限流由平台按账号计，探针 12 次/模型；游戏侧预算为 500 次/日、单拍 ≤2 次。');

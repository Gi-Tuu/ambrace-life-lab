// 魔搭托管推理选型探针：用你自己的 SDK token 逐个模型实测延迟与返回质量，不写盘、不回显密钥。
// 用法： MODELSCOPE_TOKEN=ms-xxxx node scripts/probe-model.mjs [模型id ...]
import { needsNoThink } from '../life/model-adapter.mjs';
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
// 审议层同形状：候选行动带 id，必须回 {"id":…,"reason":…}
const DECIDE = '你是村民 a1，饥饿 0.7、疲惫 0.3。可选：[{"id":12,"label":"去北区采石"},{"id":13,"label":"回家吃饭"},{"id":14,"label":"修谷仓"}]。只输出 JSON：{"id":<所选 id>,"reason":"<不超过 14 字>"}';
const CAP = Number(process.env.PROBE_CAP ?? 5000); // 与创空间将配的 MODEL_TIMEOUT_MS 对齐

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
        body: JSON.stringify(needsNoThink(id)
          ? { model: id, messages: [{ role: 'user', content: PROMPT }], max_tokens: 80, temperature: 0.9, chat_template_kwargs: { enable_thinking: false } }
          : { model: id, messages: [{ role: 'user', content: PROMPT }], max_tokens: 80, temperature: 0.9 }),
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
  const flag = p50 > CAP ? `⚠ 超单请求预算 MODEL_TIMEOUT_MS=${CAP}` : `✓ 在 ${CAP}ms 预算内`;
  console.log(`${id.padEnd(38)} P50 ${String(p50).padStart(5)}ms  n=${times.length}  ${flag}`);
  console.log(`${''.padEnd(38)} └ ${last}`);
  // 延迟合格还不够：审议层发的是 json_object 决策调用，那里失败就等于模型没上岗（线上 DeepSeek 正是这样哑掉的）。
  const jbody = { model: id, temperature: 0.85, messages: [{ role: 'user', content: DECIDE }], response_format: { type: 'json_object' }, max_tokens: 100 };
  if (needsNoThink(id)) jbody.chat_template_kwargs = { enable_thinking: false };
  const t1 = Date.now();
  let verdict = '';
  try {
    const r2 = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(jbody), signal: AbortSignal.timeout(60000) });
    const txt2 = await r2.text();
    if (!r2.ok) verdict = `✗ 决策调用 HTTP ${r2.status} ${txt2.slice(0, 60).replace(/\s+/g, ' ')}`;
    else {
      const j2 = JSON.parse(txt2);
      const msg = j2.choices?.[0]?.message ?? {};
      const raw = String(msg.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim();
      let why = '';
      try {
        const p = JSON.parse(raw);
        verdict = Number.isFinite(p.id) ? `✓ 决策 JSON 可解析 id=${p.id}` : `✗ JSON 里没有 id：${raw.slice(0, 40)}`;
      } catch (e) {
        why = `正文长=${raw.length} 思考长=${String(msg.reasoning ?? msg.reasoning_content ?? '').length} finish=${j2.choices?.[0]?.finish_reason ?? '?'}`;
        verdict = `✗ 决策 JSON 不可解析 ${why}`;
      }
    }
  } catch (e) { verdict = '✗ 决策调用异常 ' + String(e?.message ?? e).slice(0, 50); }
  console.log(`${''.padEnd(38)} └ ${verdict}（${Date.now() - t1}ms）`);
}
console.log(`\n注：单日调用配额与限流由平台按账号计，探针 4 次/模型；游戏侧预算为 500 次/日、单拍 ≤2 次。判定口径与引擎一致（needsNoThink 决定要不要带关思考参数）。`);

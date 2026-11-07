// 单次探针：确认端点能出正文、JSON 能被解析、用量字段长什么样。不打印任何凭据。
const BASE = process.env.MODEL_BASE_URL;
const MODEL = process.env.MODEL_NAME;
const KEY = process.env.MODEL_KEY;

const body = {
  model: MODEL,
  temperature: 0.5,
  messages: [
    {
      role: 'user',
      content: '你是避难所里一个谨慎的所长。当前合法候选：[{"kind":"rest","u":0.3},{"kind":"eat","u":0.2}]。只输出 JSON：{"action":"候选里的一个 kind","reason":"一句中文"}',
    },
  ],
  response_format: { type: 'json_object' },
};

const t0 = Date.now();
const res = await fetch(`${BASE.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify(body),
});
const ms = Date.now() - t0;
console.log(`HTTP ${res.status}  ${ms}ms  model=${MODEL}`);
const txt = await res.text();
if (!res.ok) {
  console.log('响应体（截 400 字，不含凭据）:', txt.slice(0, 400));
  process.exit(1);
}
const j = JSON.parse(txt);
const msg = j.choices?.[0]?.message;
console.log('finish:', j.choices?.[0]?.finish_reason);
console.log('usage:', JSON.stringify(j.usage));
console.log('content 长度:', (msg?.content ?? '').length);
console.log('content 原文:', JSON.stringify(msg?.content ?? '').slice(0, 300));
console.log('reasoning 字段存在:', 'reasoning_content' in (msg ?? {}), '长度', (msg?.reasoning_content ?? '').length);
try {
  const p = JSON.parse(String(msg.content).replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
  console.log('解析得到 action =', p.action, '| reason =', p.reason);
} catch (e) {
  console.log('!! JSON 解析失败:', e.message);
}

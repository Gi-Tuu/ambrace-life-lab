// 对话文本的唯一清洗入口：玩家输入与模型输出都必须经过这里。
// 独立成模块是为了让 resident-dialogue（玩家对话）与 resident-proactive（主动搭话）
// 共用同一把尺子，同时避免两个模块互相 import 形成环。
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g;

export const CHAT_TEXT_MAX = 240;
export const CHAT_LINE_MAX = 80;

export function normalizeChatText(value, max = CHAT_TEXT_MAX) {
  const clean = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

// 已付过成本的回答：模型偶尔用决策腔回话（{"id":"rest","reason":"…","text":"…"}）。
// 只在对象上找台词字段，先取到一句再交给 sanitize 走原有清洗；id/act/reason 绝不解释成动作。
const LINE_FIELDS = Object.freeze(['text', 'line', 'speech']);
function lineFieldOf(value) {
  const raw = String(value ?? '').replace(CONTROL, ' ').trim();
  if (!/^[\[{]/.test(raw)) return '';
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    // 带 act 的是决策体：动作语义必须由服务端裁决，绝不从决策体里捡台词。
    if (Object.hasOwn(parsed, 'act')) return '';
    for (const key of LINE_FIELDS) {
      const picked = parsed[key];
      if (typeof picked === 'string' && picked.trim()) return picked;
    }
  } catch { /* 解析失败：仍按今天的规则整段拒 */ }
  return '';
}

// 模型输出只当“一句台词”：去控制符/零宽、去引号、去 URL、压空白、截断。绝不解析成动作。
export function sanitizeModelLine(value, max = CHAT_LINE_MAX) {
  let text = normalizeChatText(lineFieldOf(value) || value, max + 40);
  text = text.replace(/^["“「『]|["”」』]$/g, '').trim();
  text = text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  // 基本注入隔离：模型若吐回非白名单 JSON/决策体（旧端点或错提示词），绝不把它当台词展示。
  if (/^[\[{]/.test(text) || /"(?:id|reason|act|topic|text|served)"\s*:/.test(text)) return '';
  return [...text].slice(0, max).join('');
}

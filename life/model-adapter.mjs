// D3：模型名/接口差异的适配层。只负责“请求体要不要带关闭思考的 chat_template_kwargs”。
// 是否支持额外参数不能靠模型名猜：调用方在同一次尝试里遇到 400/422 会去掉该参数重试。
// 点号小版本的 Qwen3.x 与 DeepSeek V4 系模板默认开启思考：实测不带参数时 finish_reason=length 且正文为空，
// 审议层静默退回替身（带参数 516ms 出完整 JSON）。无点号的历史命名保持原登记口径。
export const needsNoThink = (model) => /qwen[\/_-]?3\.\d|deepseek[\/_-]?v4/i.test(String(model ?? ''));
export const withNoThink = (base, model) => (needsNoThink(model) ? { ...base, chat_template_kwargs: { enable_thinking: false } } : base);
export const withoutNoThink = (body) => {
  if (!body || typeof body !== 'object' || !('chat_template_kwargs' in body)) return body;
  const rest = { ...body };
  delete rest.chat_template_kwargs;
  return rest;
};

// D3：模型名/接口差异的适配层。只负责“请求体要不要带 Qwen3.8 的关闭思考参数”。
// 是否支持额外参数不能靠模型名猜：调用方在同一次尝试里遇到 400/422 会去掉该参数重试。
export const needsNoThink = (model) => /qwen[\/_-]?3\.8/i.test(String(model ?? ''));
export const withNoThink = (base, model) => (needsNoThink(model) ? { ...base, chat_template_kwargs: { enable_thinking: false } } : base);
export const withoutNoThink = (body) => {
  if (!body || typeof body !== 'object' || !('chat_template_kwargs' in body)) return body;
  const rest = { ...body };
  delete rest.chat_template_kwargs;
  return rest;
};

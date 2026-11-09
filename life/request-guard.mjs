// 写路由守卫（纯函数，可单测）。serve.mjs 只负责调用与读环境变量。
// 威胁模型（HANDOVER-quality-review-2026-11-09 §5.1）：一条「JSON + 无 Origin + 无 token」的
// 脚本请求就能 POST /ctl reset 抹掉唯一历史档。浏览器同源请求带 Origin / sec-fetch-site，
// 脚本不带；因此**非 loopback 的写请求**必须出示浏览器同源证据或有效令牌，二者皆无一律拒。
// loopback 保留无令牌的开发便利；一旦配置 CTL_TOKEN，loopback 脚本也要带令牌。
export const isJson = (h) => String(h ?? '').toLowerCase().startsWith('application/json');

export function isLoopback(req) {
  const a = String(req?.socket?.remoteAddress ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost';
}

// 同源判定：sec-fetch-site 明确 cross-site 一律拒；带 Origin 时必须与 Host 一致。
export function sameOrigin(req) {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    const host = String(req?.headers?.host ?? '').toLowerCase();
    return o.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

// 浏览器证据：带 Origin，或 sec-fetch-site 明确 same-origin。脚本两者皆无。
export function browserEvidence(req) {
  return Boolean(req?.headers?.origin) || String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'same-origin';
}

// 定长比较：避免用长度或前缀差异做旁路探测
export function tokenMatches(given, expected) {
  if (!expected) return false;
  const g = String(given ?? '');
  if (g.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < g.length; i += 1) diff |= g.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const bearerOf = (req) => {
  const h = String(req?.headers?.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7) : String(req?.headers?.['x-ctl-token'] ?? '');
};

// 返回 null 表示放行，否则返回拒因字符串。
export function mutatingDenied(req, token = '') {
  if (!isJson(req?.headers?.['content-type'])) return 'NEED_JSON';
  if (!sameOrigin(req)) return 'CROSS_SITE';
  const authed = token ? tokenMatches(bearerOf(req), token) : false;
  if (browserEvidence(req) || authed) return null;
  if (isLoopback(req) && !token) return null;
  return 'UNAUTHORIZED';
}

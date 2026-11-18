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

// 同源判定：sec-fetch-site 明确 cross-site 一律拒；same-origin 是浏览器亲口给的证据，直接认。
// 为什么不能只比 Origin↔Host：创空间网关会把 Host 改写成容器内地址（实测：带
// `Origin: https://<空间>.ms.show` 的请求在容器里 Host 已不是这个值 ⇒ 每个真实访客的
// /act 都被判 CROSS_SITE，游戏里表现为"所有交互失败，请重试"）。这类代理下
// `sec-fetch-site` / `x-forwarded-host` 才是可用证据；脚本伪造 sec-fetch-site 在本规则下
// 本来就能通过（无 Origin 即视为同源），所以这里不新增旁路面。
export function sameOrigin(req) {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return false;
  if (site === 'same-origin') return true;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    const given = o.host.toLowerCase();
    const candidates = [req?.headers?.host, req?.headers?.['x-forwarded-host']]
      .flatMap((h) => String(h ?? '').split(',')).map((h) => h.trim().toLowerCase()).filter(Boolean);
    return candidates.some((h) => h === given || h.replace(/:(80|443)$/, '') === given.replace(/:(80|443)$/, ''));
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

export function nonceMatches(req) {
  const cookie = String(req?.headers?.cookie ?? '').split(';').map((x) => x.trim()).find((x) => x.startsWith('ctl_nonce='))?.slice(10);
  const given = String(req?.headers?.['x-ctl-nonce'] ?? '');
  return Boolean(cookie && given && cookie.length === given.length && tokenMatches(given, cookie));
}

export const bearerOf = (req) => {
  const h = String(req?.headers?.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7) : String(req?.headers?.['x-ctl-token'] ?? '');
};

// 返回 null 表示放行，否则返回拒因字符串。
export function mutatingDenied(req, token = '') {
  if (!isJson(req?.headers?.['content-type'])) return 'NEED_JSON';
  // 配了令牌就只认令牌：sec-fetch-site / Origin 都是任意脚本可伪造的头，
  // 不能作为"已授权"的证据（审计 SEC-02）。
  if (token) return tokenMatches(bearerOf(req), token) ? null : 'UNAUTHORIZED';
  if (!sameOrigin(req)) return 'CROSS_SITE';
  if (browserEvidence(req)) return null;
  if (isLoopback(req) && !req?.headers?.['x-forwarded-host']) return null;
  return 'UNAUTHORIZED';
}

// SEC3-01：普通交互（/act、/saves/open、/saves/back）在配了 CTL_TOKEN 时也允许同源浏览器通过；
// 令牌只锁破坏性控制面。否则"设了令牌 = 浏览器全 401"（11-16 线上全停的形态）。
export function interactionDenied(req, token = '') {
  if (!isJson(req?.headers?.['content-type'])) return 'NEED_JSON';
  if (token && tokenMatches(bearerOf(req), token)) return null;
  if (!sameOrigin(req)) return 'CROSS_SITE';
  if (browserEvidence(req)) return null;
  if (isLoopback(req) && !req?.headers?.['x-forwarded-host']) return null;
  return 'UNAUTHORIZED';
}

// SEC3-02：/ctl 的破坏性动作（reset/survival_reset/catchup/brain）在配置了令牌时必须带令牌；
// 其余 /ctl 动作（pause/resume/step/mask/compare_reset 等）仍按普通交互守卫。
export const DESTRUCTIVE_CTL = Object.freeze(['reset', 'survival_reset', 'catchup', 'brain', 'compare_reset']);
export function ctlDenied(req, body, token = '') {
  if (DESTRUCTIVE_CTL.includes(String(body?.action ?? ''))) {
    if (!isJson(req?.headers?.['content-type'])) return 'NEED_JSON';
    if (token && tokenMatches(bearerOf(req), token)) return null;
    if (!sameOrigin(req)) return 'CROSS_SITE';
    if (browserEvidence(req) && nonceMatches(req)) return null;
    return 'UNAUTHORIZED';
  }
  return interactionDenied(req, token);
}





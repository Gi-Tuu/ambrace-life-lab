// 页面到服务端的唯一出口。只做 HTTP 与 JSON，不碰 DOM——
// 「存档失败要不要提示」被拆成纯函数 persistNotices()，好单测（见 life/player-move.test.mjs）。
// 从 web/app.js 抽出（2026-11-15，阶段 4）。
// 营地选择由 app 注入（localStorage 读取留在 DOM 侧），本模块保持无 DOM 依赖、可单测。
let campProvider = null;
export function setCampProvider(fn) { campProvider = fn; }
export async function postJson(path, body) {
  // 只给会读世界的路径带 camp；/saves、/healthz 等不需要。
  let url = path;
  const camp = campProvider?.() || null;
  if (camp && (path.startsWith('/world') || path.startsWith('/act'))) {
    url = path + (path.includes('?') ? '&' : '?') + 'camp=' + encodeURIComponent(camp);
  }
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 返回 'lost' | 'ok' | null —— 与抽离前的判断逐字一致。
export function persistNotices(result, path) {
  if (result.persisted === false) return 'lost';
  if (result.persisted === true || (path.startsWith('/world') && !result.saveError)) return 'ok';
  return null;
}

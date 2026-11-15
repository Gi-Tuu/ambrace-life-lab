// 线上冒烟（零依赖）：只读检查 + 写路径的"拒绝"检查，不改世界、不写盘。
//
// 用法：
//   node scripts/smoke-online.mjs                                  # 默认 http://127.0.0.1:7860
//   SMOKE_URL=https://xxx.ms.show node scripts/smoke-online.mjs    # 公开实例
//   SMOKE_URL=... SMOKE_COOKIE='ms_session=...' node ...           # 非公开实例（浏览器里复制 Cookie）
//   SMOKE_URL=... SMOKE_STUDIO_TOKEN=... node ...                   # 魔搭私有创空间：走 ?studio_token=（浏览器地址栏里那串）
//   SMOKE_TOKEN=... node ...                                       # 顺带验 /ctl 令牌可用
//
// 退出码：0 全过；1 有失败项。

const BASE = (process.env.SMOKE_URL ?? 'http://127.0.0.1:7860').replace(/\/+$/, '');
const COOKIE = process.env.SMOKE_COOKIE ?? '';
const TOKEN = process.env.SMOKE_TOKEN ?? '';
const STUDIO_TOKEN = process.env.SMOKE_STUDIO_TOKEN ?? '';
// 魔搭 ms.show 对非浏览器 UA 直接 403（实测同一 URL：无 UA 403、带 UA 200），冒烟必须伪装成浏览器。
const UA = process.env.SMOKE_UA ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);

const rows = [];
const check = (name, ok, detail = '') => {
  rows.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const skip = (name, why) => {
  rows.push({ name, ok: true, detail: 'skipped: ' + why });
  console.log(`⏭  ${name} — 跳过（${why}）`);
};
const headers = (extra = {}) => ({ 'user-agent': UA, ...(COOKIE ? { cookie: COOKIE } : {}), ...extra });
const withToken = (path) => (STUDIO_TOKEN ? `${path}${path.includes('?') ? '&' : '?'}studio_token=${encodeURIComponent(STUDIO_TOKEN)}` : path);
const get = (path, init = {}) => fetch(BASE + withToken(path), { ...init, headers: headers(init.headers), redirect: 'manual' });

console.log(`冒烟目标: ${BASE}${LOOPBACK ? '（loopback）' : ''}\n`);

// 1) 首页与静态资源：用"新版才有的文件/符号"当版本探针
try {
  const res = await get('/');
  check('首页可访问', res.status === 200, 'HTTP ' + res.status);
  const html = await res.text();
  check('首页含 3D 画布与入口脚本', /id="cvA"/.test(html) && /web\/app\.js/.test(html));
  check('无 2D 像素视图残留', !/像素视图|pixelView/.test(html));
} catch (error) {
  check('首页可访问', false, String(error?.cause?.code ?? error));
}

try {
  const css = await get('/web/app.css');
  check('app.css 存在（v0.1.2+ 的纯 3D 结构）', css.status === 200, 'HTTP ' + css.status);
} catch (error) {
  check('app.css 存在', false, String(error?.cause?.code ?? error));
}

try {
  const r = await get('/web/camp-3d-render.mjs');
  const text = r.status === 200 ? await r.text() : '';
  check('渲染器含窗光白天因子（v0.1.4+）', /uWindowA/.test(text), r.status === 200 ? '' : 'HTTP ' + r.status);
  check('渲染器含曝光参数（v0.1.3+）', /uExposure/.test(text));
} catch (error) {
  check('渲染器版本探针', false, String(error?.cause?.code ?? error));
}

// 2) 世界快照
try {
  const res = await get('/world');
  check('/world 200', res.status === 200, 'HTTP ' + res.status);
  const world = await res.json();
  check('/world 是合法 JSON', Boolean(world));
  check('无存档失败', !world.saveError, String(world.saveError ?? ''));
  check('无决策异常', !world.tickError, String(world.tickError ?? ''));
  // GAME_MODE=game 只推进生存世界，研究世界 A/B 的 t 按设计冻结 ⇒ 计时读数取 survival。
  const live = world.survival ?? world.A ?? {};
  const liveLabel = world.survival ? 'survival' : 'A';
  check('世界在走（t>0）', Number(live.t) > 0, `${liveLabel}.t=${live.t}`);
  const agents = Object.keys(live.agents ?? {}).length;
  check('营地居民在位', agents >= 3, agents + ' 人');
  check('生存世界已载入', Boolean(world.survival), world.survival ? 'enabled' : 'null');
  check('生存世界未终局', !world.survival?.ended, world.survival ? `settlement=${world.survival.settlement}${world.survival.endReason ? ' endReason=' + world.survival.endReason : ''}` : 'n/a');
  check('对照世界 B 存在', Boolean(world.B), world.B?.t != null ? 't=' + world.B.t + (world.mode === 'game' ? '（game 模式下冻结，正常）' : '') : '');
} catch (error) {
  check('/world 可读', false, String(error?.cause?.code ?? error));
}

// 3) 健康检查
try {
  const res = await get('/healthz');
  check('/healthz 200', res.status === 200, 'HTTP ' + res.status);
  // 大脑中继只报读数不作判据：agent 不在时本来就会超时，那正是设计好的降级路径。
  try {
    const r = (await res.clone().json()).relay;
    console.log(r && !r.off
      ? `ℹ️  大脑中继 served=${r.served} expired=${r.expired} late=${r.late} dropped=${r.dropped} · 等待上限 ${r.limits?.ttlMs}ms`
      : 'ℹ️  大脑中继未启用：模型请求走配置里的供应商');
  } catch { /* 旧镜像没有 relay 字段 */ }
} catch (error) {
  check('/healthz 200', false, String(error?.cause?.code ?? error));
}

// 4) 写路径：匿名脚本必须被拒（未知 action，不会改动世界）
try {
  const res = await get('/ctl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: '__smoke_probe__' }),
  });
  if (LOOPBACK) skip('匿名脚本写请求被拒', 'loopback 有免令牌开发豁免');
  else check('匿名脚本写请求被拒（401/403）', [401, 403].includes(res.status), 'HTTP ' + res.status);

  if (TOKEN) {
    const authed = await fetch(`${BASE}/ctl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ action: '__smoke_probe__' }),
    });
    check('带令牌的写请求未被鉴权拒绝', authed.status !== 401 && authed.status !== 403, 'HTTP ' + authed.status);
  } else {
    skip('带令牌的写请求', '未提供 SMOKE_TOKEN');
  }
} catch (error) {
  check('写路径检查', false, String(error?.cause?.code ?? error));
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${failed.length ? `❌ 失败 ${failed.length} 项 / 共 ${rows.length} 项` : `✅ 全部 ${rows.length} 项通过`}`);
if (failed.length) for (const f of failed) console.log(`   · ${f.name} ${f.detail}`);
// 不用 process.exit：Windows 上 fetch 的空闲连接未关时会撞 libuv 断言（退出码变崩溃码）。
process.exitCode = failed.length ? 1 : 0;

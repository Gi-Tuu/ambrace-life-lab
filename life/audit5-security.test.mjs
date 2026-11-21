// 审计5 Batch 0：SEC5-01（nonce 必须服务端签发、绑定会话）/ SEC5-02（/world 营地 owner）
// 以及 SEC5-05（重开营地不改 owner）。全部走真 HTTP，临时 DATA_DIR。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAudit5, stopAudit5, openSession, jsonPost, jsonGet, cookieJar } from './audit5-harness.mjs';
import { ctlDenied } from './request-guard.mjs';

const RESET = { action: 'reset', confirm: true };
const unitReq = (headers = {}) => ({ headers: { 'content-type': 'application/json', host: 'x', ...headers }, socket: { remoteAddress: '203.0.113.9' } });

test('SEC5-01 纯函数：自选 nonce（无服务端校验器）永远不能授权 reset', () => {
  const forged = unitReq({
    origin: 'https://evil.example', 'sec-fetch-site': 'same-origin',
    'x-forwarded-host': 'evil.example', cookie: 'ctl_nonce=abc123', 'x-ctl-nonce': 'abc123',
  });
  assert.equal(ctlDenied(forged, RESET), 'UNAUTHORIZED');
  assert.equal(ctlDenied(forged, RESET, ''), 'UNAUTHORIZED');
});

test('SEC5-01 纯函数：只有服务端校验器认可的一次性 nonce 才放行', () => {
  const req = unitReq({ cookie: 'ctl_sid=s1; ctl_nonce=n1', 'x-ctl-nonce': 'n1' });
  assert.equal(ctlDenied(req, RESET, '', () => true), null);
  assert.equal(ctlDenied(req, RESET, '', () => false), 'UNAUTHORIZED');
  assert.equal(ctlDenied(req, { action: 'pause' }, '', () => false), 'UNAUTHORIZED', '非破坏性动作走普通交互守卫');
  assert.equal(ctlDenied(unitReq({ origin: 'https://x' }), { action: 'pause' }, '', () => false), null, '同源浏览器非破坏性动作不受 nonce 限制');
});

test('SEC5-01 纯函数：配了 CTL_TOKEN 时 nonce 默认不授权；仅 allowNonce 的 MAIN reset 例外', () => {
  const req = unitReq({ cookie: 'ctl_sid=s1; ctl_nonce=n1', 'x-ctl-nonce': 'n1', origin: 'https://x', 'sec-fetch-site': 'same-origin' });
  assert.equal(ctlDenied(req, RESET, 'tok', () => true), 'UNAUTHORIZED');
  assert.equal(ctlDenied(req, { action: 'survival_reset', confirm: true }, 'tok', () => true, { allowNonce: true }), null);
  assert.equal(ctlDenied(req, { action: 'reset', confirm: true }, 'tok', () => true, { allowNonce: true }), 'UNAUTHORIZED', '全局 reset 不得用 nonce');
  assert.equal(ctlDenied({ ...req, headers: { ...req.headers, authorization: 'Bearer tok' } }, RESET, 'tok', () => true), null);
});

test('SEC5-01 HTTP：伪造头 + 自选 nonce 的一条 POST 重置必须 403', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const r = await jsonPost(h.base, '/ctl', RESET, {
      headers: {
        cookie: 'ctl_nonce=zzz; ctl_sid=deadbeef',
        'x-ctl-nonce': 'zzz',
        origin: h.base,
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': 'evil.example',
      },
    });
    assert.equal(r.status, 403, `自选 nonce 必须被拒，实测 ${r.status} ${await r.text()}`);
  } finally { await stopAudit5(h); }
});

test('SEC5-01 HTTP：服务端签发 nonce + 会话 cookie 的浏览器路径可重置', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const jar = {};
    const { res } = await openSession(h.base, jar);
    assert.ok(jar.ctl_sid, 'GET / 必须签发 HttpOnly 会话 cookie');
    assert.ok(jar.ctl_nonce, 'GET / 必须签发服务端 nonce');
    const setCookies = res.headers.getSetCookie().join('\n');
    assert.match(setCookies, /ctl_sid=[0-9a-f]{32}/);
    assert.match(setCookies, /HttpOnly/i, '会话 cookie 必须 HttpOnly');
    assert.match(setCookies, /SameSite=Strict/i, '会话 cookie 必须 SameSite=Strict');
    // 故意不带 Origin/Sec-Fetch-Site：授权只来自服务端会话+nonce，不靠可伪造头。
    const r = await jsonPost(h.base, '/ctl', RESET, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
  } finally { await stopAudit5(h); }
});

test('SEC5-01 HTTP：CTL_TOKEN 姿态下无令牌/伪造头一律 403，Bearer 可用', async () => {
  const h = await bootAudit5({ CTL_TOKEN: 'top-secret' });
  try {
    const jar = {};
    await openSession(h.base, jar);
    const anon = await jsonPost(h.base, '/ctl', RESET, {
      jar, headers: { 'x-ctl-nonce': jar.ctl_nonce, origin: h.base, 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'evil.example' },
    });
    assert.equal(anon.status, 403, '令牌姿态下合法 nonce 也不能绕过令牌');
    const noNonce = await jsonPost(h.base, '/ctl', RESET, { headers: { authorization: 'Bearer top-secret', origin: h.base } });
    assert.equal(noNonce.status, 200, '运维令牌单独可用（令牌本身即凭据）');
  } finally { await stopAudit5(h); }
});

test('SEC5-05 HTTP：令牌姿态下 MAIN survival_reset 走服务端 nonce（浏览器可用，脚本无凭据 403，3 次/分钟限速 + 审计）', async () => {
  const h = await bootAudit5({ CTL_TOKEN: 'top-secret' });
  try {
    const noCred = await jsonPost(h.base, '/ctl', { action: 'survival_reset', confirm: true });
    assert.equal(noCred.status, 403, '无会话/nonce 的脚本必须 403');

    const jar = {};
    await openSession(h.base, jar);
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await jsonPost(h.base, '/ctl', { action: 'survival_reset', confirm: true }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
      statuses.push(r.status);
      cookieJar(r, jar); // 一次性 nonce：响应会带回新的 ctl_nonce
      if (r.status === 200) assert.equal((await r.json()).ok, true);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429], `前 3 次放行、第 4 次限速：${statuses}`);
    const out = h.out();
    assert.match(out, /\[audit\] main_reset/, '必须写审计事件');
    assert.match(out, /"result":"ok"/);
    assert.match(out, /"result":"rate_limited"/);

    // 全局 reset 仍只认令牌：合法 nonce 也不能 reset
    const globalReset = await jsonPost(h.base, '/ctl', RESET, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    assert.equal(globalReset.status, 403, '全局 reset 不得走 nonce');
  } finally { await stopAudit5(h); }
});

test('SEC5-05 HTTP：MAIN reset nonce 短 TTL，过期后必须重新取', async () => {
  const h = await bootAudit5({ CTL_TOKEN: 'top-secret', CTL_NONCE_TTL_MS: '600' });
  try {
    const jar = {};
    await openSession(h.base, jar);
    await new Promise((r) => setTimeout(r, 900));
    const stale = await jsonPost(h.base, '/ctl', { action: 'survival_reset', confirm: true }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    assert.equal(stale.status, 403, `过期 nonce 必须拒绝，实测 ${stale.status}`);
    await openSession(h.base, jar);
    const fresh = await jsonPost(h.base, '/ctl', { action: 'survival_reset', confirm: true }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    assert.equal(fresh.status, 200, '重新取 nonce 后应可用');
  } finally { await stopAudit5(h); }
});

test('DATA5-05 索引删除后重开仍归原 owner；重启从侧车重建索引', async () => {
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const h = await bootAudit5({ CTL_TOKEN: '' });
  const dir = h.dir;
  let h2 = null;
  try {
    const jarA = {};
    const rA = await jsonPost(h.base, '/saves/open', { name: '侧车营地' }, { jar: jarA });
    cookieJar(rA, jarA);
    const a = await rA.json();
    assert.ok(a.ok, JSON.stringify(a));
    const ownerA = jarA.camp_owner;
    assert.ok(ownerA);

    // 索引整体删除（模拟索引丢失）
    rmSync(join(dir, 'saves', 'index.json'));
    await stopAudit5(h);

    // 重启：从 saves/*.json.gz + .owner.json 侧车重建索引
    h2 = await bootAudit5({ CTL_TOKEN: '', DATA_DIR: dir });
    const list = await (await jsonGet(h2.base, '/saves')).json();
    assert.ok(list.entries.some((e) => e.name === '侧车营地'), `重建索引必须恢复显示名：${JSON.stringify(list.entries)}`);

    const rB = await jsonPost(h2.base, '/saves/open', { name: '侧车营地' }, { jar: {} });
    assert.equal(rB.status, 403, '非 owner 重开必须仍是 CAMP_OWNED');
    assert.equal((await rB.json()).error, 'CAMP_OWNED');
    const rA2 = await jsonPost(h2.base, '/saves/open', { name: '侧车营地' }, { jar: { camp_owner: ownerA } });
    assert.equal(rA2.status, 200, '原 owner 必须能重开');
    const world = await jsonGet(h2.base, `/world?camp=${a.key}`, { jar: { camp_owner: ownerA } });
    assert.equal(world.status, 200);
  } finally {
    if (h2) await stopAudit5(h2);
    await stopAudit5(h);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEC5-02 HTTP：/world?camp= 无 cookie / 他人 = 访客投影、owner 200（A′ 后写路由仍 403）', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const jarA = {};
    const rA = await jsonPost(h.base, '/saves/open', { name: '审计营地甲' }, { jar: jarA });
    cookieJar(rA, jarA);
    const a = await rA.json();
    assert.ok(a.ok, JSON.stringify(a));
    assert.ok(jarA.camp_owner, '/saves/open 必须给创建者发 owner cookie');

    const jarB = {};
    const rB = await jsonPost(h.base, '/saves/open', { name: '审计营地乙' }, { jar: jarB });
    cookieJar(rB, jarB);
    const b = await rB.json();
    assert.ok(b.ok);

    // A′（2026-11-22）：无 owner cookie 不再 403，只给独立白名单投影；完整 survival 仍只给 owner。
    const noCookie = await jsonGet(h.base, `/world?camp=${a.key}`);
    assert.equal(noCookie.status, 200, '无 owner cookie 应拿到访客投影');
    const guest = await noCookie.json();
    assert.equal(guest.guest, true);
    assert.ok(!Object.hasOwn(guest, 'survival'), '访客投影不得含 survival');

    const owner = await jsonGet(h.base, `/world?camp=${a.key}`, { jar: { camp_owner: jarA.camp_owner } });
    assert.equal(owner.status, 200, 'owner 应能读自己的营地');
    const ownerBody = await owner.json();
    assert.equal(ownerBody.camp?.key, a.key);
    assert.ok(ownerBody.survival, 'owner 仍拿完整 survival');

    const other = await jsonGet(h.base, `/world?camp=${a.key}`, { jar: { camp_owner: jarB.camp_owner } });
    assert.equal(other.status, 200, '他人的 owner cookie 只拿到访客投影');
    const otherBody = await other.json();
    assert.equal(otherBody.guest, true);
    assert.ok(!Object.hasOwn(otherBody, 'survival'), '他人不得拿到 survival');
  } finally { await stopAudit5(h); }
});

test('SEC5-05 重开已归属营地：不换 owner、不发新 cookie、明确 403 CAMP_OWNED', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const jarA = {};
    const rA = await jsonPost(h.base, '/saves/open', { name: '归属测试营地' }, { jar: jarA });
    cookieJar(rA, jarA);
    const a = await rA.json();
    const ownerA = jarA.camp_owner;
    assert.ok(a.ok && ownerA);

    // 完全不同的浏览器（无 camp_owner）重开同名营地
    const rB = await jsonPost(h.base, '/saves/open', { name: '归属测试营地' }, { jar: {} });
    const bBody = await rB.json();
    const bCookies = rB.headers.getSetCookie();
    assert.equal(rB.status, 403, `非 owner 重开必须拒绝，实测 ${rB.status} ${JSON.stringify(bBody)}`);
    assert.equal(bBody.error, 'CAMP_OWNED');
    assert.ok(!bCookies.some((c) => c.startsWith('camp_owner=')), '不得给非 owner 下发新 owner cookie');

    // 原 owner 重开仍可用；之后读世界仍是他的
    const rA2 = await jsonPost(h.base, '/saves/open', { name: '归属测试营地' }, { jar: { camp_owner: ownerA } });
    assert.equal(rA2.status, 200);
    const world = await jsonGet(h.base, `/world?camp=${a.key}`, { jar: { camp_owner: ownerA } });
    assert.equal(world.status, 200);
  } finally { await stopAudit5(h); }
});

test('SEC5-05 MAIN survival_reset：未设令牌时服务端 nonce 可重开一局（浏览器路径）', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const jar = {};
    await openSession(h.base, jar);
    const r = await jsonPost(h.base, '/ctl', { action: 'survival_reset', confirm: true }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
  } finally { await stopAudit5(h); }
});

test('SEC5-06 安全头/ cookie 标志：CSP、nosniff、frame-ancestors 白名单、Secure', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '', COOKIE_SECURE: '1' });
  try {
    const res = await jsonGet(h.base, '/');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    // 所有者口径（2026-11-19 线上白屏复盘）：创空间实例在 https://<空间>.ms.show，外层再被
    // modelscope.cn 嵌一层。frame-ancestors 'none' 或漏掉 *.ms.show 都会让平台那一格被浏览器
    // 拦成空白页——白屏真因就是这个。所以按源放行只放魔搭两域，绝不放开成裸 *。
    const directive = (csp.match(/frame-ancestors([^;]*)/) ?? [])[1] ?? '';
    const sources = directive.trim().split(/\s+/).filter(Boolean);
    assert.ok(sources.includes("'self'"), `frame-ancestors 缺 self：${directive}`);
    assert.ok(sources.includes('https://*.ms.show'), `frame-ancestors 缺创空间实例域 https://*.ms.show：${directive}`);
    assert.ok(sources.includes('https://modelscope.cn'), `frame-ancestors 缺 modelscope.cn：${directive}`);
    assert.ok(sources.includes('https://www.modelscope.cn'), `frame-ancestors 缺 www.modelscope.cn：${directive}`);
    assert.equal(sources.includes('*'), false, 'frame-ancestors 不许出现裸 *：那等于放弃防点击劫持');
    assert.equal(/frame-ancestors 'none'/.test(csp), false, "'none' 会把创空间自己也挡掉，线上就是白屏");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), null, 'XFO 表达不了"按源放行"，留着 DENY 会比 CSP 更严、再次挡掉 iframe');
    const setCookies = res.headers.getSetCookie().join('\n');
    assert.match(setCookies, /ctl_sid=[0-9a-f]{32}[^\n]*Secure/i);
    assert.match(setCookies, /ctl_sid=[^\n]*HttpOnly/i);
  } finally { await stopAudit5(h); }
});

test('SEC5-06 saveError 不回显绝对路径', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'audit5-file-'));
  const file = join(base, 'not-a-dir');
  writeFileSync(file, 'x');
  const h = await bootAudit5({ CTL_TOKEN: '', DATA_DIR: file });
  try {
    await jsonPost(h.base, '/act', { mode: 'survival', kind: 'move', room: 'hall' });
    const res = await jsonGet(h.base, '/healthz');
    assert.equal(res.status, 503, '主档写失败必须 503');
    const text = await res.text();
    const body = JSON.parse(text);
    assert.ok(body.world?.saveError, '必须报告 saveError');
    assert.ok(!text.includes(file), '不得回显绝对路径');
    assert.ok(!/file already exists|ENOTDIR|EEXIST:/.test(text), `只回错误码，不回 fs 原文：${text.slice(0, 300)}`);
  } finally { await stopAudit5(h); }
});

test('SEC5-03 MAIN catchup 统一冷却（连点第二次被拒）', async () => {
  const h = await bootAudit5({ CTL_TOKEN: '' });
  try {
    const jar = {};
    await openSession(h.base, jar);
    const first = await jsonPost(h.base, '/ctl', { action: 'catchup', minutes: 30 }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    assert.equal((await first.json()).ok, true);
    cookieJar(first, jar); // nonce 一次性：第一次用掉后响应下发新的
    const second = await jsonPost(h.base, '/ctl', { action: 'catchup', minutes: 30 }, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
    const body = await second.json();
    assert.equal(body.ok, false, 'MAIN 也必须冷却');
    assert.equal(body.error, 'CATCHUP_COOLDOWN');
  } finally { await stopAudit5(h); }
});

test('SEC5-04 匿名配额：同一会话最多 5 个营地；NaN env 回落而不是 0', async () => {
  const h = await bootAudit5({
    CTL_TOKEN: '', OPEN_LIMIT: 'NaN', OPEN_LIMIT_GLOBAL: 'NaN',
    OPEN_SESSION_LIMIT: 'NaN', CAMP_TOTAL_MAX: 'NaN',
  });
  try {
    const jar = {};
    await openSession(h.base, jar);
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await jsonPost(h.base, '/saves/open', { name: `配额营地${i}` }, { jar });
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200], `前 5 个应放行：${codes}`);
    assert.equal(codes[5], 429, `第 6 个必须被会话配额挡住：${codes}`);
  } finally { await stopAudit5(h); }
});

// 说明：cookie 属性（HttpOnly/Secure）只在原始 set-cookie 行里；harness 的 cookiesOf 只保留 name=value。

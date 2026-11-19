// SA10：query 路由（不靠 cookie）——带 ?camp= 与不带必须指向不同世界。
// 起真服务（spawn），零联网零模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'route-'));
  // 不用 Math.random：lint 要求测试可复现；用 pid 派生避免并行端口冲突。
  const port = 8191 + (process.pid % 40);
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BRAIN: 'local',
      DATA_DIR: dataDir, SEED_FILE: join(ROOT, 'seed', 'world.json'),
      TICK_MS: '10000000', GAME_RULES: '1', GAME_MODE: 'game', MODEL_UNATTENDED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  for (let i = 0; i < 120 && !out.includes('就绪'); i += 1) await new Promise((r) => setTimeout(r, 150));
  if (!out.includes('就绪')) { child.kill(); throw new Error('server boot timeout: ' + out.slice(0, 300)); }
  return { child, base: `http://127.0.0.1:${port}` };
}

const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (base, path) => (await fetch(base + path)).json();

test('SA10 query 路由：?camp=A 与 ?camp=B 各在自己的世界，不带则主营地', async () => {
  const { child, base } = await boot();
  try {
    const aRes = await post(base, '/saves/open', { name: '甲' });
    const a = await aRes.json();
    const aOwner = /camp_owner=([^;]+)/.exec(aRes.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const bRes = await post(base, '/saves/open', { name: '乙' });
    const b = await bRes.json();
    const bOwner = /camp_owner=([^;]+)/.exec(bRes.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const auth = (owner) => ({ cookie: 'camp_owner=' + owner });
    const postAuth = (path, body, owner) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(owner) }, body: JSON.stringify(body) });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.key, b.key);

    // 只对甲发动作（query 指定营地，完全不带 cookie）
    const act = await (await postAuth(`/act?camp=${a.key}`, { mode: 'survival', kind: 'move', room: 'garden' }, aOwner)).json();
    assert.ok(act.ok, JSON.stringify(act));

    const wa = await (await fetch(base + `/world?camp=${a.key}`, { headers: auth(aOwner) })).json();
    const wb = await (await fetch(base + `/world?camp=${b.key}`, { headers: auth(bOwner) })).json();
    const wm = await get(base, '/world');
    assert.equal(wa.camp?.key, a.key, '带 camp 应返回该营地');
    assert.equal(wa.camp?.name, '甲', 'camp.name 必须是名字而不是哈希（P2-a）');
    assert.equal(wb.camp?.key, b.key, '另一份营地也要能读');
    assert.equal(wm.camp, null, '不带 camp 必须是主营地');
    assert.equal(wa.survival.loc?.p1, 'garden', '动作必须落到 ?camp= 指定的世界');
    assert.notEqual(wb.survival.loc?.p1, 'garden', '不得落到另一份世界');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test('SA11 非法/未登记 camp：无 owner 403；带 owner 仍回落主营地、不回显输入', async () => {
  const { child, base } = await boot();
  try {
    const rOpen = await post(base, '/saves/open', { name: '甲' });
    const a = await rOpen.json();
    const ownerA = /camp_owner=([^;]+)/.exec(rOpen.headers.get('set-cookie') ?? '')?.[1] ?? '';
    assert.ok(a.ok);
    assert.ok(ownerA, '首次打开必须发 owner cookie');
    // SEC5-02：非 MAIN 读路径一律先过 owner 门，畸形 key 也一样（不回显请求原语）。
    {
      const r = await fetch(base + '/world?camp=' + encodeURIComponent('../etc/passwd'));
      assert.equal(r.status, 403, '无 owner cookie 不得读非 MAIN');
      const body = await r.text();
      assert.ok(!body.includes('../etc/passwd'), '不得回显请求原语');
    }
    // 格式合法但未登记（等价 TTL 已回收）：有 owner cookie 时显式 invalid，仍给主营地世界（SAV-05）
    {
      const bad = 'a'.repeat(32);
      const r = await (await fetch(base + '/world?camp=' + bad, { headers: { cookie: 'camp_owner=' + 'f'.repeat(32) } })).json();
      assert.equal(r.camp?.invalid, true, '失效 key 必须显式标记 invalid');
      assert.equal(r.camp?.key, bad);
      assert.notEqual(r.survival, null, '仍要给出可看的世界');
    }
    const noOwner = await fetch(base + '/world?camp=' + a.key);
    assert.equal(noOwner.status, 403, '无 cookie 不得读已登记营地');
    const ok = await (await fetch(base + '/world?camp=' + a.key, { headers: { cookie: 'camp_owner=' + ownerA } })).json();
    assert.equal(ok.camp?.key, a.key, '合法已登记 key + owner 仍然正常');
    assert.notEqual(ok.survival, null);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});


// SA12 读路径本身的回归：安全上下文里建档签发的 owner cookie，下一次带它读必须回到自己的营地；
// 不带则 403（SEC5-02）。cookie 的 SameSite 属性由 SA13 钉——这条是手工带 cookie 头，验不了属性。
test('SA12 安全上下文里建档签发的 owner cookie，下一次读必须 200（无 cookie 仍 403）', async () => {
  const { child, base } = await boot();
  const H = { 'content-type': 'application/json', 'x-forwarded-proto': 'https' };
  try {
    const rOpen = await fetch(base + '/saves/open', { method: 'POST', headers: H, body: JSON.stringify({ name: '丁' }) });
    const opened = await rOpen.json();
    assert.ok(opened.ok && opened.key, '建档应成功');
    // 同一次响应里取 cookie：再发一次就没有 owner 了，会被正确地判成 CAMP_OWNED。
    const cookies = rOpen.headers.getSetCookie();
    const owner = (/camp_owner=([^;]+)/.exec(cookies.find((c) => c.startsWith('camp_owner=')) ?? '') ?? [])[1] ?? '';
    assert.ok(owner, '建档必须签发 camp_owner');
    const withOwner = await (await fetch(base + '/world?camp=' + opened.key, { headers: { cookie: 'camp_owner=' + owner } })).json();
    assert.equal(withOwner.camp?.key, opened.key, '带着 owner cookie 必须读回自己的营地');
    assert.notEqual(withOwner.survival, null, '读到的应是该营地的世界，而不是回落主营地');
    const anonymous = await fetch(base + '/world?camp=' + opened.key);
    assert.equal(anonymous.status, 403, 'SEC5-02：不带 owner cookie 仍不得读别人的营地');
    assert.equal((await anonymous.json()).error, 'CAMP_NOT_OWNER');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

// SA14：客户端必须把"认不出你"当成要给用户一条路，而不是继续无限重试到白屏。
test('SA14 客户端认得 CAMP_NOT_OWNER 并清掉营地指针（不再空白重试）', () => {
  const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(src, /CAMP_NOT_OWNER/, 'app.js 里必须把"营地不是你的"与网络故障分开');
  const at = src.indexOf('CAMP_NOT_OWNER');
  assert.ok(at > 0 && src.length - at > 300, '定位到读世界那段 catch');
  assert.match(src.slice(at - 400, at + 900), /setCampKey\(null\)/, '这条码要落回主营地，否则下一轮还在读同一个读不通的营地');
  assert.equal(/e\.code==='CAMP_UNAVAILABLE'\s*\?\s*'当前名字营地暂时无法加载，正在重试。' : '无法连接生存服务，正在重试。';/.test(src), false,
    '旧写法把 403 也当成网络故障无限重试，正是白屏的成因');
});

// SA13 属性层面钉住同一条：安全上下文里 camp/camp_owner 必须 SameSite=None，
// 而 ctl 会话与 nonce 继续 Strict（CSRF 那层不许被顺手放宽）。
test('SA13 安全上下文下 camp/camp_owner 必须 SameSite=None，而 ctl 会话保持 Strict', async () => {
  const { child, base } = await boot();
  try {
    const r = await fetch(base + '/saves/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ name: '丙' }),
    });
    await r.json();
    const cookies = r.headers.getSetCookie();
    const owner = cookies.find((c) => c.startsWith('camp_owner=')) ?? '';
    const camp = cookies.find((c) => c.startsWith('camp=')) ?? '';
    assert.ok(owner, '建档必须签发 camp_owner');
    assert.match(owner, /SameSite=None/, '跨站 iframe 里 Lax 等于不发：camp_owner 必须 SameSite=None');
    assert.match(owner, /Secure/, 'SameSite=None 必须配 Secure');
    assert.match(owner, /HttpOnly/, 'owner 令牌不许给脚本读');
    assert.match(camp, /SameSite=None/, 'camp 指针同样要能跨站带回');
    for (const c of cookies.filter((x) => /^ctl_(sid|nonce)=/.test(x))) assert.match(c, /SameSite=Strict/, 'CSRF 会话侧不许放宽');
    // 回落对照：非安全上下文（本地 http）必须保持 Lax，否则浏览器会直接丢弃 None+无 Secure 的 cookie。
    const plain = await fetch(base + '/saves/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '戊' }) });
    await plain.json();
    const plainOwner = plain.headers.getSetCookie().find((c) => c.startsWith('camp_owner=')) ?? '';
    assert.match(plainOwner, /SameSite=Lax/, '本地 http 下仍用 Lax：None 在没有 Secure 时会被浏览器丢掉');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

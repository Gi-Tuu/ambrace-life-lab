// SA10：query 路由（不靠 cookie）——带 ?camp= 与不带必须指向不同世界。
// 起真服务（spawn），零联网零模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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


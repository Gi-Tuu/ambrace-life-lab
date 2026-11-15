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
    const a = await (await post(base, '/saves/open', { name: '甲' })).json();
    const b = await (await post(base, '/saves/open', { name: '乙' })).json();
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.key, b.key);

    // 只对甲发动作（query 指定营地，完全不带 cookie）
    const act = await (await post(base, `/act?camp=${a.key}`, { mode: 'survival', kind: 'move', room: 'garden' })).json();
    assert.ok(act.ok, JSON.stringify(act));

    const wa = await get(base, `/world?camp=${a.key}`);
    const wb = await get(base, `/world?camp=${b.key}`);
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

test('SA11 非法/未登记 camp 回落主营地：survival 不为空、不回显输入、camp=null', async () => {
  const { child, base } = await boot();
  try {
    const a = await (await post(base, '/saves/open', { name: '甲' })).json();
    assert.ok(a.ok);
    for (const bad of ['../etc/passwd', 'a'.repeat(32)]) {
      const r = await (await fetch(base + '/world?camp=' + encodeURIComponent(bad))).json();
      assert.equal(r.camp, null, '非法/未登记 camp 必须回落 MAIN：' + bad);
      assert.notEqual(r.survival, null, '不得把空世界发给访客：' + bad);
      assert.ok(!JSON.stringify(r).includes('../etc/passwd'), '不得回显请求原语');
    }
    const ok = await (await fetch(base + '/world?camp=' + a.key)).json();
    assert.equal(ok.camp?.key, a.key, '合法已登记 key 仍然正常');
    assert.notEqual(ok.survival, null);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

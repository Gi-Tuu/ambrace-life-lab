// SA15：A′ 访客只读投影。
// 换设备/清 cookie 的玩家必须能看见自己的村子还在，但**只能看见白名单里的五项**：
// 营地名字、day、人口、settlement 状态、最近 3 条事件摘要（kind 文案，不带 agent id）。
// 绝不给 inv/pinv/relations/converseLog/talk/dialogue/locs/loc/playerPos/sites/buildings。
// 同时钉住：/act、/saves/open 的 owner 门一行不松；非法 key 仍走原回落（403，不变成访客投影）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'guest-'));
  const port = 8240 + (process.pid % 50);
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BRAIN: 'local',
      DATA_DIR: dataDir, SEED_FILE: join(ROOT, 'seed', 'world.json'),
      TICK_MS: '10000000', GAME_MS_PER_MINUTE: '10000000', GAME_RULES: '1', GAME_MODE: 'game', MODEL_UNATTENDED: '0',
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

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const world = (base, key, headers = {}) => fetch(base + '/world?camp=' + encodeURIComponent(key), { headers });

// 所有者口径点名的禁列字段，逐条断言（不许写“字段较少”这种含糊判据）。
const FORBIDDEN = [
  'survival', 'inv', 'pinv', 'relations', 'converseLog', 'talk', 'dialogue',
  'locs', 'loc', 'playerPos', 'sites', 'buildings', 'agents', 'store', 'plots',
];

test('SA15 访客只读投影：白名单五项、与 owner 同刻一致、写路由仍 403', async () => {
  const { child, base } = await boot();
  try {
    const openRes = await post(base, '/saves/open', { name: '访客甲' });
    const opened = await openRes.json();
    const owner = /camp_owner=([^;]+)/.exec(openRes.headers.get('set-cookie') ?? '')?.[1] ?? '';
    assert.ok(opened.ok && opened.key, '建档应成功');
    assert.ok(owner, '首次打开必须签发 camp_owner');

    // 1) 无 owner cookie：200 + 独立白名单投影
    const guestRes = await world(base, opened.key);
    assert.equal(guestRes.status, 200, '无 owner cookie 读 /world 必须是 200 访客投影（A′），不能再 403');
    const guest = await guestRes.json();
    assert.equal(guest.guest, true, '必须显式标记访客态');
    assert.equal(guest.camp?.key, opened.key);
    assert.equal(guest.camp?.name, '访客甲');
    assert.equal(typeof guest.day, 'number');
    assert.equal(typeof guest.population, 'number');
    const guestJson = JSON.stringify(guest);
    for (const k of FORBIDDEN) {
      assert.ok(!Object.hasOwn(guest, k), `访客投影不得含顶层字段 ${k}`);
      assert.ok(!guestJson.includes(`"${k}"`), `访客投影（含嵌套）不得出现字段 ${k}`);
    }
    assert.ok(Array.isArray(guest.events), 'events 必须是数组');
    assert.ok(guest.events.length <= 3, '事件摘要最多 3 条');
    for (const row of guest.events) {
      assert.deepEqual(Object.keys(row), ['kind'], '事件摘要只允许 kind，不得带 agent id / 明细');
      assert.equal(typeof row.kind, 'string');
    }
    for (const id of ['"a1"', '"a2"', '"a3"', '"a4"', '"a5"', '"a6"', '"p1"']) {
      assert.ok(!guestJson.includes(id), `访客投影不得带 agent id ${id}`);
    }

    // 2) 带 owner cookie：完整 survival 仍在（回归不破）
    const ownerRes = await world(base, opened.key, { cookie: 'camp_owner=' + owner });
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json();
    assert.ok(ownerBody.survival && typeof ownerBody.survival === 'object', 'owner 视图必须仍含完整 survival');
    assert.ok(Object.hasOwn(ownerBody.survival, 'inv'), 'owner 视图必须仍含 inv');
    assert.ok(Object.hasOwn(ownerBody.survival, 'pinv'), 'owner 视图必须仍含 pinv');
    assert.ok(Object.hasOwn(ownerBody.survival, 'agents'), 'owner 视图必须仍含 agents');

    // 3) 同刻一致：day / 人口 / settlement / 最近 3 条事件与 owner 视图逐项相同
    assert.equal(guest.day, ownerBody.survival.day, '访客的 day 必须与 owner 视图同刻一致');
    const population = Object.values(ownerBody.survival.agents ?? {}).filter((a) => !a.dead && !a.isPlayer).length;
    assert.equal(guest.population, population, '访客的人口数必须与 owner 视图同刻一致');
    assert.equal(guest.settlement, ownerBody.survival.settlement ?? null, '访客的 settlement 必须与 owner 视图同刻一致');
    const rows = ownerBody.survival.settlementEvents ?? [];
    assert.deepEqual(
      guest.events.map((e) => e.kind),
      rows.slice(-3).map((r) => r.kind),
      '访客事件摘要必须是 owner 事件流的最近 3 条 kind',
    );

    // 4) 访客只读：/act 与 /saves/open 的 owner 门一行都不许放松
    const actRes = await post(base, '/act?camp=' + encodeURIComponent(opened.key), { mode: 'survival', kind: 'move', room: 'hall' });
    assert.equal(actRes.status, 403, '无 owner cookie 的 /act 仍必须 403');
    assert.equal((await actRes.json()).error, 'CAMP_NOT_OWNER');
    const reopen = await post(base, '/saves/open', { name: '访客甲' });
    assert.equal(reopen.status, 403, '无 owner cookie 的同名 /saves/open 仍必须 403');
    assert.equal((await reopen.json()).error, 'CAMP_OWNED');

    // 5) 非法 / 未登记 key：仍走原回落，不得因为“允许访客”变成 200 投影
    const traversal = await world(base, '../etc/passwd');
    assert.equal(traversal.status, 403, '穿越串仍必须 403');
    assert.ok(!(await traversal.text()).includes('../etc/passwd'), '不得回显请求原语');
    const unregistered = await world(base, 'a'.repeat(32));
    assert.equal(unregistered.status, 403, '格式合法但未登记的 key 仍必须 403（SAV-05 口径）');

    // 6) 客户端访客态：显示实话，并隐藏会 403 的入口（继续生存 / 工具栏 / 背包）
    const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
    const message = '你在看别人的村子，不能操作；要用这台浏览器玩，请换个名字新开一段';
    const at = src.indexOf(message);
    assert.ok(at > 0, 'app.js 必须显示访客态文案');
    const around = src.slice(Math.max(0, at - 2500), at + 2500);
    assert.match(around, /j\.guest|\.guest\b/, '客户端必须识别 /world 的访客标记');
    assert.match(around, /\$\('startSurvival'\)\.hidden\s*=\s*true/, '访客态必须隐藏「继续生存」');
    assert.match(around, /\$\('hotbar'\)\.hidden\s*=\s*true/, '访客态必须隐藏工具栏');
    assert.match(around, /\$\('backpack'\)\.close|closeBackpack\(\)/, '访客态不得留着可开的背包');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
});

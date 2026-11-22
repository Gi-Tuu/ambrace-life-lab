// EXPORT-01..05：#52 营地备份（导出/导入成对）。
// 纪律：token 未配置即整组 404（默认关闭）；token 只从 query 读、constant-time 比较；
// 响应/错误体不得出现 token 或 saves 路径。导入先过 validCampArchive，坏档与越界 key 零写入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validCampArchive } from './camp-instances.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TOKEN = randomBytes(16).toString('hex'); // 测试进程内生成，仓库里不落任何口令字面量

const root = mkdtempSync(join(tmpdir(), 'export-'));
const srcDir = join(root, 'src');
const dstDir = join(root, 'dst');
const offDir = join(root, 'off');
const limDir = join(root, 'lim');      // EXPORT-06/07：小请求体上限 + 小令牌桶
const orphanDir = join(root, 'orphan'); // EXPORT-08：存在但无主的旧档
mkdirSync(srcDir, { recursive: true });
mkdirSync(dstDir, { recursive: true });
mkdirSync(offDir, { recursive: true });
mkdirSync(limDir, { recursive: true });
mkdirSync(orphanDir, { recursive: true });

const portBase = 8340 + (process.pid % 40);
const children = [];

async function boot({ dataDir, port, token = '', extraEnv = {} }) {
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BRAIN: 'local',
      DATA_DIR: dataDir, SEED_FILE: join(ROOT, 'seed', 'world.json'),
      TICK_MS: '10000000', GAME_MS_PER_MINUTE: '10000000', GAME_RULES: '1', GAME_MODE: 'game', MODEL_UNATTENDED: '0',
      SAVE_EXPORT_TOKEN: token, ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  for (let i = 0; i < 160 && !out.includes('就绪'); i += 1) await new Promise((r) => setTimeout(r, 150));
  if (!out.includes('就绪')) throw new Error('server boot timeout: ' + out.slice(0, 300));
  return { child, base: `http://127.0.0.1:${port}` };
}

const src = { base: '' };
const dst = { base: '' };
const off = { base: '' };
const lim = { base: '' };
const orphan = { base: '' };
const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const ownerOf = (res) => /camp_owner=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
const oworld = async (base, key, owner) => {
  const res = await fetch(base + '/world?camp=' + encodeURIComponent(key), { headers: { cookie: 'camp_owner=' + owner } });
  return { status: res.status, body: await res.json() };
};
const tree = (dir) => {
  try { return readdirSync(dir, { recursive: true }).map(String).sort(); } catch { return []; }
};

// 测试期间创建的两个营地：key -> owner cookie
const camps = new Map();
let exported = null;

before(async () => {
  const [s, d, o, l, p] = await Promise.all([
    boot({ dataDir: srcDir, port: portBase, token: TOKEN }),
    boot({ dataDir: dstDir, port: portBase + 20, token: TOKEN }),
    boot({ dataDir: offDir, port: portBase + 40, token: '' }),
    // EXPORT-06/07：请求体上限压到 4 KB、令牌桶压到 2 且几乎不回水，才能在小数据量下打到 413/429
    boot({ dataDir: limDir, port: portBase + 60, token: TOKEN, extraEnv: { SAVE_IMPORT_MAX_BYTES: '4096', EXPORT_BURST: '2', EXPORT_REFILL_MS: '600000' } }),
    boot({ dataDir: orphanDir, port: portBase + 80, token: TOKEN }),
  ]);
  src.base = s.base; dst.base = d.base; off.base = o.base; lim.base = l.base; orphan.base = p.base;
});
after(() => { for (const child of children) child.kill(); });

test('EXPORT-01 未配置 SAVE_EXPORT_TOKEN：/export 与 /import 一律 404（默认关闭）', async () => {
  const e = await fetch(off.base + '/export');
  assert.equal(e.status, 404, '未配 token 时 /export 必须 404');
  const i = await post(off.base, '/import', { version: 1, camps: {} });
  assert.equal(i.status, 404, '未配 token 时 /import 必须 404');
  const text = await i.text();
  assert.ok(!text.includes('EXPORT') && !text.includes('UNAUTHORIZED'), '404 不得暗示端点存在');
});

test('EXPORT-02 配了 token：错误 token 401；正确导出包逐档可过 validCampArchive', async () => {
  const wrong = await fetch(src.base + '/export?export_token=' + encodeURIComponent(TOKEN + 'x'));
  assert.equal(wrong.status, 401, '错误 token 必须 401');
  assert.ok(!(await wrong.text()).includes(TOKEN), '401 响应不得回显 token');

  const a = await post(src.base, '/saves/open', { name: '备份甲' });
  const b = await post(src.base, '/saves/open', { name: '备份乙' });
  const aBody = await a.json(); const bBody = await b.json();
  assert.ok(aBody.ok && bBody.ok);
  camps.set(aBody.key, ownerOf(a));
  camps.set(bBody.key, ownerOf(b));
  assert.ok([...camps.values()].every(Boolean), '两个营地都要有 owner cookie');

  const res = await fetch(src.base + '/export?export_token=' + encodeURIComponent(TOKEN));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(TOKEN), '导出响应不得出现 token');
  assert.ok(!text.includes(srcDir), '导出响应不得出现 saves 绝对路径');
  exported = JSON.parse(text);
  assert.ok(exported && typeof exported === 'object');
  assert.ok(exported.index && Array.isArray(exported.index.entries), '导出包必须带 index');
  const listed = await (await fetch(src.base + '/saves')).json();
  assert.equal(Object.keys(exported.camps).length, listed.entries.length, '导出档数必须等于 listCamps() 档数');
  for (const [key, item] of Object.entries(exported.camps)) {
    assert.match(key, /^[0-9a-f]{32}$/);
    const raw = JSON.parse(gunzipSync(Buffer.from(String(item.archive ?? ''), 'base64')).toString('utf8'));
    assert.ok(validCampArchive(raw), `导出档 ${key} 必须能过 validCampArchive`);
    assert.ok(item.owner && typeof item.owner === 'object', '每档必须带 owner 侧车');
  }
});

test('EXPORT-03 换新 DATA_DIR 导入：名字/day/store/owner 侧车逐档恢复，索引重建', async () => {
  assert.ok(exported, '前置：先有导出包');
  const res = await post(dst.base, '/import?export_token=' + encodeURIComponent(TOKEN), exported);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(TOKEN), '导入响应不得出现 token');
  assert.ok(!text.includes(dstDir), '导入响应不得出现 saves 绝对路径');
  const result = JSON.parse(text);
  assert.equal(result.imported, camps.size, '全部新档必须 imported');
  assert.equal(result.rejected, 0);
  assert.equal(result.skipped, 0);

  const listed = await (await fetch(dst.base + '/saves')).json();
  for (const [key, owner] of camps) {
    const before = await oworld(src.base, key, owner);
    const saved = listed.entries.find((e) => e.name === before.body.camp?.name);
    assert.ok(saved, `导入后索引里必须有「${before.body.camp?.name}」（/saves 按六项投影，不带 key）`);
    const after = await oworld(dst.base, key, owner);
    assert.equal(after.status, 200, '导入后带原 owner cookie 必须还能读自己的营地（侧车随档恢复）');
    assert.equal(after.body.camp?.name, before.body.camp?.name, '营地名字必须逐档一致');
    assert.equal(after.body.survival?.day, before.body.survival?.day, 'day 必须逐档一致');
    assert.equal(after.body.survival?.store, before.body.survival?.store, 'store 必须逐档一致');
  }
});

test('EXPORT-04 坏档负控：导入 rejected，且原档字节一字不变', async () => {
  const key = [...camps.keys()][0];
  const file = join(dstDir, 'saves', key + '.json.gz');
  const original = readFileSync(file);
  const tampered = structuredClone(exported);
  tampered.camps[key] = { ...tampered.camps[key], archive: gzipSync(Buffer.from('{}')).toString('base64') };
  const res = await post(dst.base, '/import?export_token=' + encodeURIComponent(TOKEN), tampered);
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.imported, 0, '坏档不得被导入');
  assert.equal(result.skipped, camps.size - 1, '别的已存在且带 owner 的档应 skipped');
  assert.equal(result.rejected, 1, '坏档（{}）必须 rejected');
  assert.ok(readFileSync(file).equals(original), '坏档不得覆盖原档：字节必须一字不变');
});

test('EXPORT-05 越界 key 负控：零写入，saves/ 之外没有任何新文件', async () => {
  const before = tree(root);
  const forged = {
    version: 1,
    camps: {
      '../../etc': { archive: gzipSync(Buffer.from('{}')).toString('base64'), owner: null },
      '..\\..\\etc': { archive: gzipSync(Buffer.from('{}')).toString('base64'), owner: null },
      'etc/passwd': { archive: gzipSync(Buffer.from('{}')).toString('base64'), owner: null },
    },
  };
  const res = await post(dst.base, '/import?export_token=' + encodeURIComponent(TOKEN), forged);
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.imported, 0, '越界 key 不得产生任何导入');
  assert.equal(result.rejected, 3, '三个越界 key 必须逐个 rejected');
  assert.equal(result.skipped, 0);
  assert.deepEqual(tree(root), before, '越界 key 必须零写入：整棵测试目录文件枚举必须不变');
  assert.equal(existsSync(join(root, 'etc')), false, 'saves/ 之外不得出现新文件');
  assert.equal(existsSync(join(root, 'etc.json.gz')), false, 'saves/ 之外不得出现新档');
  // 合法文件仍在（零写入不是把别人的档删了）
  for (const key of camps.keys()) assert.ok(statSync(join(dstDir, 'saves', key + '.json.gz')).isFile());
});

// ─── 主会话复验时补的三条：对面回报"未单独验证"的那三面 ───

test('EXPORT-06 超大请求体：/import 413 BODY_TOO_LARGE，响应不回显 token 与绝对路径', async () => {
  const key = [...camps.keys()][0];
  const huge = { version: 1, camps: { [key]: { archive: 'A'.repeat(64 * 1024), owner: null } } };
  const res = await post(lim.base, '/import?export_token=' + encodeURIComponent(TOKEN), huge);
  const text = await res.text();
  assert.equal(res.status, 413, `超过 SAVE_IMPORT_MAX_BYTES 必须 413，实测 ${res.status}｜${text.slice(0, 120)}`);
  assert.ok(text.includes('BODY_TOO_LARGE'), `413 必须给明确错误码：${text.slice(0, 120)}`);
  assert.ok(!text.includes(TOKEN) && !text.includes(limDir), '413 响应不得出现 token 或 saves 绝对路径');
});

test('EXPORT-07 令牌桶限流：超过 EXPORT_BURST 后 429，且不按客户端 IP', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await fetch(lim.base + '/export?export_token=' + encodeURIComponent(TOKEN))).status);
  assert.ok(statuses.includes(429), `桶容量 2、窗口 600 s，四次请求里必须出现 429：${statuses.join(',')}`);
  assert.ok(statuses.filter((s) => s === 200).length <= 2, `200 的次数不得超过桶容量（含 EXPORT-06 消耗的那一枚）：${statuses.join(',')}`);
  // 429 不得暗示"再试别的认证"：它只说明桶空了
  const last = await fetch(lim.base + '/export?export_token=' + encodeURIComponent(TOKEN));
  assert.equal(last.status, 429);
  assert.ok((await last.text()).includes('RATE_LIMITED'), '限流必须给明确错误码');
});

test('EXPORT-08 无主旧档允许被合法导入覆盖（有主的绝不覆盖，见 EXPORT-04）', async () => {
  const key = [...camps.keys()][0];
  const rawNew = JSON.parse(gunzipSync(Buffer.from(exported.camps[key].archive, 'base64')).toString('utf8'));
  const rawOld = structuredClone(rawNew);
  rawOld.survival.store = (Number(rawOld.survival?.store) || 0) + 7;   // 可辨认的旧态
  const dir = join(orphanDir, 'saves');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, key + '.json.gz'), gzipSync(Buffer.from(JSON.stringify(rawOld))));
  // 索引里这条**不带 ownerHash**，也不写 owner 侧车 ⇒ "存在但无主"
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    generation: 1, entries: [{ key, name: '无主旧档', day: 40, population: 6, status: 'active', lastSeenAt: Date.now() }],
  }));

  const res = await post(orphan.base, '/import?export_token=' + encodeURIComponent(TOKEN), exported);
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.skipped, 0, '无主旧档不该被 skipped：' + JSON.stringify(result));
  assert.equal(result.imported, Object.keys(exported.camps).length, '无主旧档与全新档都应 imported');
  const onDisk = JSON.parse(gunzipSync(readFileSync(join(dir, key + '.json.gz'))).toString('utf8'));
  assert.equal(onDisk.survival.store, rawNew.survival.store, '无主旧档必须被包里的新态覆盖');
});

// 第四轮 N4：观看打点只认请求自带的 camp，不得兜到 S.campKey（跨访客串味会绕过三态调度）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'n4-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '10000000';
process.env.BRAIN = 'local';
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.MODEL_UNATTENDED = '0';

const { campViewerKeys, host, openCamp } = await import('./host.mjs');

test('N4 不带 camp 的主营地轮询不得把最后打开的营地标成"有人看"', async (t) => {
  t.after(() => { try { host.stop(); } catch { /* 已停 */ } });
  await host.start();
  host.stop();
  const opened = await openCamp('阿禾');
  assert.ok(opened.ok, JSON.stringify(opened));
  const key = opened.key;
  // 此时 S.campKey === key；一次不带 camp 的轮询必须记到 MAIN，而不是 key
  host.touch('survival',key);
  assert.equal(host.snapshot('survival').survival.model.watching,false);
  assert.equal(host.snapshot('survival',key).survival.model.watching,true);
  host.stop();
  await host.start();
  host.stop();
  host.touch('survival');
  const keys = campViewerKeys();
  assert.ok(keys.includes('MAIN'), '不带 camp 的打点应记到主营地，实测 ' + JSON.stringify(keys));
  assert.ok(!keys.includes(key), '不得把最后打开的营地标成有人看，实测 ' + JSON.stringify(keys));
  // 明确带了那份营地才算有人看
  host.touch('survival', key);
  assert.ok(campViewerKeys().includes(key), '请求自带该 camp 时必须打点');
});

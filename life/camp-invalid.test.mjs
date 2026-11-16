// SAV-05 闸门：失效营地 key 的路由一致性（view 标 invalid、act 拒绝、touch 不回落、不误记 MAIN）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'sav05-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '10000000';
process.env.BRAIN = 'local';
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.MODEL_UNATTENDED = '0';

const { campViewerKeys, host, openCamp } = await import('./host.mjs');
const BAD = 'a'.repeat(32); // 格式合法、未登记 ⇒ 等价于"已被 TTL 扫掉"

test('SAV-05 失效营地：view 标记 invalid 并回落 MAIN；act 明确拒绝；touch 不污染观看判据', async (t) => {
  t.after(() => { try { host.stop(); } catch { /* 已停 */ } });
  await host.start();
  host.stop();
  const opened = await openCamp('阿禾');
  assert.ok(opened.ok);

  const snap = host.snapshot('survival', BAD);
  assert.equal(snap.camp?.invalid, true, '失效 key 必须显式标记 invalid');
  assert.equal(snap.camp?.key, BAD);
  assert.notEqual(snap.survival, null, '仍要给出可看的世界（主营地），不能空白');

  const act = await host.act({ mode: 'survival', kind: 'move', room: 'hall' }, BAD);
  assert.equal(act.ok, false);
  assert.equal(act.code, 'CAMP_INVALID', '动作必须明确拒绝，不得静默作用到主营地');

  host.touch('survival', BAD);
  const keys = campViewerKeys();
  assert.ok(!keys.includes(BAD), '失效 key 不得被打点');
  assert.ok(!keys.includes('MAIN'), '失效 key 的请求也不得把 MAIN 记成 watched');
});

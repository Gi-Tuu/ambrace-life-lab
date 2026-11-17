// P1 SEC3-01/02：令牌姿态（浏览器交互不受令牌影响、破坏性 /ctl 要令牌）与营地归属。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const req = (headers = {}) => ({ headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '203.0.113.9' } });
const browser = () => req({ origin: 'https://example.ms.show', host: 'example.ms.show' });
const bare = () => req();

const { interactionDenied, ctlDenied } = await import('./request-guard.mjs');
const TOKEN = 'secret-token';

test('SEC3-01 配了 CTL_TOKEN：浏览器同源 /act 仍放行；匿名 /act 拒', () => {
  assert.equal(interactionDenied(browser(), TOKEN), null, '同源浏览器交互不该被令牌锁死');
  assert.equal(interactionDenied(bare(), TOKEN), 'UNAUTHORIZED', '匿名脚本仍要令牌');
  assert.equal(interactionDenied(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), null);
});

test('SEC3-02 配了 CTL_TOKEN：破坏性 /ctl 必须带令牌，非破坏性仍按交互守卫', () => {
  for (const action of ['reset', 'survival_reset', 'catchup', 'brain']) {
    assert.equal(ctlDenied(browser(), { action }, TOKEN), 'UNAUTHORIZED', `${action} 匿名应拒`);
    assert.equal(ctlDenied(req({ authorization: `Bearer ${TOKEN}` }), { action }, TOKEN), null, `${action} 带令牌应放行`);
  }
  assert.equal(ctlDenied(browser(), { action: 'pause' }, TOKEN), null, '非破坏性 /ctl 不该被令牌锁');
});

const DIR = mkdtempSync(join(tmpdir(), 'p1-sec3-'));
mkdirSync(join(DIR, 'saves'), { recursive: true });
process.env.DATA_DIR = DIR;
const host = await import('./host.mjs');

test('SEC3-02 营地归属：首次 claim 绑定，之后换人 claim 不抢占，哈希不落原文', () => {
  writeFileSync(join(DIR, 'saves', 'index.json'), JSON.stringify({ entries: [{ key: 'k1', name: '甲', lastSeenAt: Date.now() }] }));
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  assert.equal(host.campOwnerHash('k1'), null);
  const first = host.claimCamp('k1', hashA);
  assert.equal(first.claimed, true);
  assert.equal(host.campOwnerHash('k1'), hashA);
  const second = host.claimCamp('k1', hashB);
  assert.equal(second.claimed, false);
  assert.equal(second.owned, false, '换人不算 owner');
  assert.equal(host.campOwnerHash('k1'), hashA, '归属不得被后来者改写');
});

test.after(() => { delete process.env.DATA_DIR; rmSync(DIR, { recursive: true, force: true }); });

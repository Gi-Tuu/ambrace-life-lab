// 审计修复闸门：令牌不可被伪造头绕过；多 provider 不跨家使用密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutatingDenied } from './request-guard.mjs';
import { pickProviderKey, modelChannel } from './host.mjs';

const req = (headers) => ({ headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });

test('SEC-02 配了令牌就只认令牌：伪造 same-origin/Origin 不得放行', () => {
  const spoof = req({ origin: 'http://127.0.0.1:8200', host: '127.0.0.1:8200', 'sec-fetch-site': 'same-origin' });
  assert.equal(mutatingDenied(spoof, 'secret'), 'UNAUTHORIZED');
  assert.equal(mutatingDenied({ ...spoof, headers: { ...spoof.headers, authorization: 'Bearer secret' } }, 'secret'), null);
  assert.equal(mutatingDenied({ ...spoof, headers: { ...spoof.headers, authorization: 'Bearer wrong' } }, 'secret'), 'UNAUTHORIZED');
});

test('SEC-02-PROXY 未配令牌：反代来源（x-forwarded-host）不得再走 loopback 免检', () => {
  const proxied = req({ host: '127.0.0.1:7860', 'x-forwarded-host': 'ambrace.ms.show' });
  assert.equal(mutatingDenied(proxied, ''), 'UNAUTHORIZED', '经反代的脚本请求应要求同源证据/令牌');
});

test('SEC-04 多 provider 缺 key：不得回退使用第 0 家的 key', () => {
  assert.equal(pickProviderKey(['k1'], 1, 2), '', '两 provider 只有一把 key 时第二家必须为空');
  assert.equal(pickProviderKey(['k1'], 0, 2), 'k1');
  assert.equal(pickProviderKey(['k1', 'k2'], 1), 'k2');
  assert.equal(pickProviderKey(['k1'], 0), 'k1', '单 provider 保持原行为');
});

test('CONC-01 世界 lane 能看到已被 /chat 占用的预算（同一本账）', () => {
  const blocked = modelChannel({ watched: true, free: false, moneyCalls: 1, nodeCalls: 0, moneyBudget: 1, nodeBudget: 0 });
  assert.equal(blocked.go, false);
  assert.equal(blocked.why, 'BUDGET');
});

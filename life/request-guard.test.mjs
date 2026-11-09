// 写路由守卫闸门（HANDOVER-quality-review-2026-11-09 §5.1）。
// 每条都能变红：把 request-guard 里对应的判定撤掉，本文件相应断言即红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mutatingDenied, isLoopback, browserEvidence, tokenMatches } from './request-guard.mjs';

const req = (headers = {}, addr = '203.0.113.7') => ({ headers, socket: { remoteAddress: addr } });
const JSONH = { 'content-type': 'application/json', host: 'lab.example' };

test('G1 非 loopback + 无 Origin + 无 token 的脚本写请求必须被拒（reset 抹档洞）', () => {
  assert.equal(mutatingDenied(req(JSONH), ''), 'UNAUTHORIZED');
});

test('G2 非 loopback 的浏览器同源请求放行（带 Origin 或 sec-fetch-site same-origin）', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, origin: 'http://lab.example' }), ''), null);
  assert.equal(mutatingDenied(req({ ...JSONH, 'sec-fetch-site': 'same-origin' }), ''), null);
});

test('G3 跨站一律拒；非 JSON 一律拒', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }), ''), 'CROSS_SITE');
  assert.equal(mutatingDenied(req({ ...JSONH, origin: 'http://evil.example' }), ''), 'CROSS_SITE');
  assert.equal(mutatingDenied(req({ 'content-type': 'text/plain', host: 'lab.example' }), ''), 'NEED_JSON');
});

test('G4 非 loopback 带正确令牌放行、错令牌拒；loopback 设了令牌也要带', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, authorization: 'Bearer s3cret' }), 's3cret'), null);
  assert.equal(mutatingDenied(req({ ...JSONH, 'x-ctl-token': 's3cret' }), 's3cret'), null);
  assert.equal(mutatingDenied(req({ ...JSONH, authorization: 'Bearer wrong!' }), 's3cret'), 'UNAUTHORIZED');
  assert.equal(mutatingDenied(req(JSONH, '127.0.0.1'), 's3cret'), 'UNAUTHORIZED');
});

test('G5 loopback 无令牌保留开发便利；isLoopback/browserEvidence 判定正确', () => {
  assert.equal(mutatingDenied(req(JSONH, '127.0.0.1'), ''), null);
  assert.equal(mutatingDenied(req(JSONH, '::1'), ''), null);
  assert.equal(mutatingDenied(req(JSONH, '::ffff:127.0.0.1'), ''), null);
  assert.equal(isLoopback(req(JSONH, '203.0.113.7')), false);
  assert.equal(browserEvidence(req(JSONH)), false);
  assert.equal(browserEvidence(req({ ...JSONH, origin: 'http://lab.example' })), true);
});

test('G6 令牌比较定长：长度不同直接 false，不做前缀旁路', () => {
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('abcd', 'abcd'), true);
  assert.equal(tokenMatches('', 'abcd'), false);
  assert.equal(tokenMatches('abcd', ''), false);
});

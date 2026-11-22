// 写路由守卫闸门（HANDOVER-quality-review-2026-11-09 §5.1）。
// 每条都能变红：把 request-guard 里对应的判定撤掉，本文件相应断言即红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mutatingDenied, isLoopback, browserEvidence, tokenMatches } from './request-guard.mjs';

const req = (headers = {}, addr = '203.0.113.7') => ({ headers, socket: { remoteAddress: addr } });
const JSONH = { 'content-type': 'application/json', host: 'lab.example' };

test('GUARD-G1 非 loopback + 无 Origin + 无 token 的脚本写请求必须被拒（reset 抹档洞）', () => {
  assert.equal(mutatingDenied(req(JSONH), ''), 'UNAUTHORIZED');
});

test('GUARD-G2 非 loopback 的浏览器同源请求放行（带 Origin 或 sec-fetch-site same-origin）', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, origin: 'http://lab.example' }), ''), null);
  assert.equal(mutatingDenied(req({ ...JSONH, 'sec-fetch-site': 'same-origin' }), ''), null);
});

test('GUARD-G3 跨站一律拒；非 JSON 一律拒', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' }), ''), 'CROSS_SITE');
  assert.equal(mutatingDenied(req({ ...JSONH, origin: 'http://evil.example' }), ''), 'CROSS_SITE');
  assert.equal(mutatingDenied(req({ 'content-type': 'text/plain', host: 'lab.example' }), ''), 'NEED_JSON');
});

test('GUARD-G4 非 loopback 带正确令牌放行、错令牌拒；loopback 设了令牌也要带', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, authorization: 'Bearer s3cret' }), 's3cret'), null);
  assert.equal(mutatingDenied(req({ ...JSONH, 'x-ctl-token': 's3cret' }), 's3cret'), null);
  assert.equal(mutatingDenied(req({ ...JSONH, authorization: 'Bearer wrong!' }), 's3cret'), 'UNAUTHORIZED');
  assert.equal(mutatingDenied(req(JSONH, '127.0.0.1'), 's3cret'), 'UNAUTHORIZED');
});

test('GUARD-G5 loopback 无令牌保留开发便利；isLoopback/browserEvidence 判定正确', () => {
  assert.equal(mutatingDenied(req(JSONH, '127.0.0.1'), ''), null);
  assert.equal(mutatingDenied(req(JSONH, '::1'), ''), null);
  assert.equal(mutatingDenied(req(JSONH, '::ffff:127.0.0.1'), ''), null);
  assert.equal(isLoopback(req(JSONH, '203.0.113.7')), false);
  assert.equal(browserEvidence(req(JSONH)), false);
  assert.equal(browserEvidence(req({ ...JSONH, origin: 'http://lab.example' })), true);
});

test('GUARD-G6 令牌比较定长：长度不同直接 false，不做前缀旁路', () => {
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('abcd', 'abcd'), true);
  assert.equal(tokenMatches('', 'abcd'), false);
  assert.equal(tokenMatches('abcd', ''), false);
});

// 线上真实形状：创空间网关把 Host 改写成容器内地址，浏览器仍带 Origin: https://<空间>.ms.show。
// 旧实现只比 Origin↔Host ⇒ 每个访客的 /act 都是 CROSS_SITE，游戏里就是"所有交互失败，请重试"。
// 本地测不出来（本地 Host 与 Origin 一致），所以这三条断言必须写在这里。
test('G7 网关改写 Host 后，浏览器访客的写请求仍须放行', () => {
  const STUDIO = 'https://gituuu-ambrace-life-lab.ms.show';
  const proxied = { ...JSONH, host: '0.0.0.0:7860', origin: STUDIO, 'sec-fetch-site': 'same-origin' };
  assert.equal(mutatingDenied(req(proxied), ''), null, '浏览器亲口 same-origin ⇒ 必须放行');
  const fwd = { ...JSONH, host: '0.0.0.0:7860', 'x-forwarded-host': 'gituuu-ambrace-life-lab.ms.show', origin: STUDIO };
  assert.equal(mutatingDenied(req(fwd), ''), null, '没有 sec-fetch-site 时 x-forwarded-host 也算同源证据');
  const ported = { ...JSONH, host: 'lab.example:443', origin: 'https://lab.example' };
  assert.equal(mutatingDenied(req(ported), ''), null, '默认端口不参与比较');
});

test('GUARD-G8 跨站证据优先；same-origin 证据与旧行为一样可被脚本伪造（不新增旁路）', () => {
  assert.equal(mutatingDenied(req({ ...JSONH, host: '0.0.0.0:7860', 'x-forwarded-host': 'lab.example', origin: 'http://lab.example', 'sec-fetch-site': 'cross-site' }), ''),
    'CROSS_SITE', '网关转发不能翻掉浏览器明确给出的 cross-site');
  assert.equal(mutatingDenied(req({ ...JSONH, host: '0.0.0.0:7860', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }), ''),
    null, '脚本本来就能伪造这个头（旧实现里"无 Origin 即视为同源"同样放行）；防的是浏览器里的跨站页面，不是 curl');
});

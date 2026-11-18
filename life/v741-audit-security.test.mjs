import test from 'node:test';
import assert from 'node:assert/strict';
import { ctlDenied, interactionDenied } from './request-guard.mjs';
const req = (h = {}) => ({ headers: { 'content-type': 'application/json', host: 'x', ...h }, socket: { remoteAddress: '203.0.113.9' } });
const reset = { action: 'reset', confirm: true };
// SEC5-01：nonce 由服务端签发并绑定会话；客户端自设的 cookie/header 对永远不构成凭据。
const selfChosen = { cookie: 'ctl_sid=fake; ctl_nonce=abc123', 'x-ctl-nonce': 'abc123' };
test('SEC4-01 匿名 reset 无服务端 nonce 必须 403', () => assert.equal(ctlDenied(req({ origin: 'https://x' }), reset), 'UNAUTHORIZED'));
test('SEC4-01 伪造 Origin/同源头仍不能匿名 reset', () => assert.equal(ctlDenied(req({ origin: 'https://x', 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'x' }), reset), 'UNAUTHORIZED'));
test('SEC5-01 自选 nonce 对不能授权 reset', () => assert.equal(ctlDenied(req({ origin: 'https://x', 'sec-fetch-site': 'same-origin', ...selfChosen }), reset), 'UNAUTHORIZED'));
test('SEC5-01 服务端校验器认可的 nonce 才放行 reset', () => assert.equal(ctlDenied(req(selfChosen), reset, '', () => true), null));
test('SEC4-02 设 token 时 Bearer 可 reset', () => assert.equal(ctlDenied(req({ authorization: 'Bearer tok' }), reset, 'tok'), null));
test('SEC5-01 设 token 时 nonce 姿态不放行 reset（令牌只认令牌）', () => assert.equal(ctlDenied(req({ ...selfChosen, origin: 'https://x', 'sec-fetch-site': 'same-origin' }), reset, 'tok', () => true), 'UNAUTHORIZED'));
test('SEC4-02 ctl reset 无凭据拒绝', () => assert.equal(ctlDenied(req({ origin: 'https://x' }), reset), 'UNAUTHORIZED'));
test('SEC4-03 cross-site 一律拒', () => assert.equal(interactionDenied(req({ 'sec-fetch-site': 'cross-site' })), 'CROSS_SITE'));

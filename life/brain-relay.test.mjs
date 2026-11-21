// 大脑中继闸门：这是一条会把公开实例的模型请求交给外部进程的路，语义必须钉死——
// 一次投递、超时不复活、队列满就立刻失败、迟到答案绝不塞给已经走开的等待方。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRelay, constantTimeEqual } from './brain-relay.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('R1 提交→取活→交活：等待方拿到内容，一次投递不重发', async () => {
  const rel = createRelay({ maxPending: 4, ttlMs: 2000 });
  const job = rel.submit({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(job && job.id, 'submit 应返回 {id,promise}');
  assert.equal(rel.view().pending, 1);

  const got = rel.claim();
  assert.equal(got.id, job.id);
  assert.equal(got.body.model, 'qwen3.8-27b');
  assert.equal(rel.claim(), null, '同一条活不能被取两次');

  assert.equal(rel.complete(got.id, { content: '嗯', usage: { total_tokens: 7 } }), true);
  const res = await job.promise;
  assert.equal(res.ok, true);
  assert.equal(res.content, '嗯');
  assert.deepEqual(res.usage, { total_tokens: 7 });
  assert.deepEqual(
    { p: rel.view().pending, c: rel.view().claimed, served: rel.view().served },
    { p: 0, c: 0, served: 1 }, '交活后三个计数都要归位');
});

test('R2 超时：等待方拿到 RELAY_TIMEOUT，迟到的结果被丢弃并计数', async () => {
  const rel = createRelay({ maxPending: 2, ttlMs: 40 });
  const job = rel.submit({ model: 'm' });
  const got = rel.claim();
  await sleep(90);
  const res = await job.promise;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RELAY_TIMEOUT');
  assert.equal(rel.view().expired, 1);
  assert.equal(rel.complete(got.id, { content: '太晚了' }), false, '已超时的活不能再算成功');
  assert.equal(rel.view().late, 1);
  assert.equal(rel.view().served, 0);
});

test('R3 排队中的活过期也会被结算，且队列满时立刻失败不堆积', async () => {
  const rel = createRelay({ maxPending: 1, ttlMs: 40 });
  const first = rel.submit({ model: 'a' });
  assert.equal(rel.submit({ model: 'b' }), null, '队列满 ⇒ submit 返回 null');
  assert.equal(rel.view().dropped, 1);
  assert.deepEqual(await first.promise, { ok: false, code: 'RELAY_TIMEOUT' });
  assert.equal(rel.claim(), null, '过期后不该再被取走');
});

test('节点取活后仍占容量，交活和超时各自释放容量', async () => {
  const rel = createRelay({ maxPending: 1, ttlMs: 500 });
  const first = rel.submit({ model: 'a' });
  assert.equal(rel.claim().id, first.id);
  assert.equal(rel.view().pending, 0);
  assert.equal(rel.view().claimed, 1);
  assert.equal(rel.submit({ model: 'blocked' }), null);
  assert.equal(rel.view().dropped, 1);
  assert.equal(rel.complete(first.id, { content: 'ok' }), true);
  assert.equal((await first.promise).ok, true);

  const next = rel.submit({ model: 'b' });
  assert.equal(rel.claim().id, next.id);
  assert.deepEqual(await next.promise, { ok: false, code: 'RELAY_TIMEOUT' });
  assert.equal(rel.view().claimed, 0);

  const last = rel.submit({ model: 'c' });
  assert.equal(rel.claim().id, last.id);
  assert.equal(rel.complete(last.id, { content: 'ok' }), true);
  assert.equal((await last.promise).ok, true);
});

test('R4 未知 id 与令牌比较', () => {
  const rel = createRelay({ maxPending: 1, ttlMs: 1000 });
  assert.equal(rel.complete('nope', { content: 'x' }), false);
  assert.equal(rel.view().late, 1);
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false, '长度不同也必须为假，且不得提前返回真');
  assert.equal(constantTimeEqual(null, ''), false, '任一侧为空都不能算相等：否则没配令牌等于默认开放');
  assert.equal(constantTimeEqual('', ''), false);
  assert.equal(constantTimeEqual(undefined, 'tok'), false);
});

test('A07 中继失败计数是可持久化的整数', async () => {
  const relay=createRelay();
  const job=relay.submit({});
  relay.claim();
  assert.equal(relay.complete(job.id,{ok:false,code:'MOCK_ERROR'}),true);
  assert.equal((await job.promise).ok,false);
  assert.equal(JSON.parse(JSON.stringify(relay.view())).failed,1);
});

// R9（2026-11-21）：公开实例的网关按 UA 判断——node 默认 UA 一律 403（Code 10010101007）。
test('R9 中继 agent 必须带浏览器 UA，否则公开实例把它当非浏览器挡掉', () => {
  const src = readFileSync(resolve(process.cwd(), 'scripts', 'brain-agent.mjs'), 'utf8');
  assert.ok(src.includes("'user-agent': UA"), 'fetch 头里必须显式带 user-agent');
  assert.ok(src.includes("const UA = 'Mozilla"), 'UA 要是浏览器串，空串或 node 默认都没用');
});

// V7.3.4 A：actionId 实例稳定、同刻同类区分、重复完成不重复、按刻直读。
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvent, createActionObserver } from './action-observer.mjs';
import { measureIdle } from './idle-probe.mjs';

test('V734-A actionId：同刻同类两实例、重复完成去重、eventsAt', () => {
  const o = createActionObserver();
  const a = actionEvent({ actorId: 'a1', actionId: 'a1:gather:5:1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10 });
  const b = actionEvent({ actorId: 'a1', actionId: 'a1:gather:5:2', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10 });
  assert.equal(o.feed(a), true);
  assert.equal(o.feed(b), true);
  assert.equal(o.eventsAt(5).length, 2, '同刻两次同类必须是两个实例');
  assert.equal(o.feed({ ...a }), false, '重复完成通知不得重复累计');
});

test('V734-A-OBSERVE-2DAY 真实 2 日观测：actionId 唯一、每实例每状态最多一次', async () => {
  const r = await measureIdle(7, 2);
  assert.ok(Array.isArray(r.events) && r.events.length > 0);
  const ids = new Set();
  for (const e of r.events) {
    assert.ok(e.actionId, '事件必须有 actionId');
    const key = e.actionId + '|' + e.status;
    assert.ok(!ids.has(key), '重复 actionId+status: ' + key);
    ids.add(key);
  }
  const byTick = new Map();
  for (const e of r.events) byTick.set(e.worldTick, (byTick.get(e.worldTick) ?? 0) + 1);
  assert.ok(byTick.size > 0);
  assert.equal(r.observer.n, r.events.length);
});

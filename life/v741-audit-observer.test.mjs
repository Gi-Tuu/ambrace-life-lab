import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionObserver, actionEvent } from './action-observer.mjs';
test('ARCH4-05 eventsAt 命中只返回该刻', () => { const o = createActionObserver(); for (let t = 1; t <= 5; t += 1) o.feed(actionEvent({ actorId: 'a1', actionId: 'a1:rest:' + t + ':1', worldTick: t, kind: 'rest', status: 'completed' })); assert.equal(o.eventsAt(3).length, 1); assert.equal(o.eventsAt(3)[0].worldTick, 3); });
test('ARCH4-05 超 cap 后旧刻索引被删', () => { const o = createActionObserver({ cap: 2 }); for (let t = 1; t <= 3; t += 1) o.feed(actionEvent({ actorId: 'a1', actionId: 'a1:rest:' + t + ':1', worldTick: t, kind: 'rest', status: 'completed' })); assert.equal(o.eventsAt(1).length, 0); assert.equal(o.eventsAt(3).length, 1); });
test('ARCH4-05 raw 不限 events cap 但独立限长', () => { const o = createActionObserver({ cap: 1 }); for (let t = 1; t <= 4; t += 1) o.feed(actionEvent({ actorId: 'a1', actionId: 'a1:rest:' + t + ':1', worldTick: t, kind: 'rest', status: 'completed' })); assert.ok(o.raw.length <= 2); });

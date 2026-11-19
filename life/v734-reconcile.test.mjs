// V7.3.4 E：对账索引（重复完成/缺开始/分钟偏差/干净样本）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEvent } from './action-observer.mjs';
import { reconcile } from './ledger-reconcile.mjs';

test('V734-REC 重复完成/多最终态必须进不一致清单', () => {
  const e = actionEvent({ actorId: 'a1', actionId: 'a1:gather:5:1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10 });
  const r = reconcile({ events: [e, { ...e }], ledger: {} });
  assert.ok(r.counts.duplicateFinal >= 1);
  assert.equal(r.anomalies[0].actionId, 'a1:gather:5:1');
});

test('V734-REC 完成早于开始必须进清单', () => {
  const e = actionEvent({ actorId: 'a1', actionId: 'a1:gather:10:1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10 });
  const r = reconcile({ events: [e], ledger: {} });
  assert.ok(r.anomalies.some((x) => x.type === 'COMPLETE_BEFORE_START'));
});

test('V734-REC 分钟偏差与账本差异；干净样本为空', () => {
  const bad = actionEvent({ actorId: 'a1', actionId: 'a1:gather:5:1', worldTick: 6, kind: 'gather', status: 'completed', actualMinutes: 20 });
  const r = reconcile({ events: [bad], ledger: { a1: { byKind: { gather: { minutes: 10 } } } }, costs: { gather: { minutes: 10 } } });
  assert.ok(r.anomalies.some((x) => x.type === 'MINUTES_DEVIATION'));
  assert.ok(r.anomalies.some((x) => x.type === 'LEDGER_MINUTES_MISMATCH'));
  const ok = actionEvent({ actorId: 'a1', actionId: 'a1:gather:5:1', worldTick: 5, kind: 'gather', status: 'completed', actualMinutes: 10 });
  const clean = reconcile({ events: [ok], ledger: { a1: { byKind: { gather: { minutes: 10 } } } }, costs: { gather: { minutes: 10 } } });
  assert.equal(clean.counts.anomalies, 0, JSON.stringify(clean.anomalies));
});

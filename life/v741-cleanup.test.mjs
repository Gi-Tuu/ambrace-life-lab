// V7.4.1 清理闸门：旧档未知字段忽略、默认无实验调度字段、M3 on 无 errors。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

test('V741-CLEAN 旧档 fairSched/m3GraceWait 未知字段可读且被忽略', () => {
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  const raw = dumpSurv(sp);
  raw.fairSched = { cap: 2, debt: { a1: 1 }, last: { a1: 1 } };
  raw.minds = raw.minds ?? {};
  raw.minds.a1 = { ...(raw.minds.a1 ?? {}), m3GraceWait: 4, fairSched: { cap: 2 } };
  const back = loadSurv(structuredClone(raw), 7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.ok(back.world);
  assert.equal(back.world.fairSched, undefined, 'fairSched 不得复活');
  assert.equal(back.world.agents.a1.m3GraceWait, undefined, 'grace 字段不得复活');
  assert.equal(back.world.agents.a1.m3GraceTicks, undefined);
});

test('V741-CLEAN 默认无 fair 调度，M3 on 仍无 agentErrors', async () => {
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  assert.equal(sp.world.fairSched, undefined);
  const m3 = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  for (let i = 0; i < 24 * 3; i += 1) await tickSurvPlay(m3);
  assert.equal(m3.world.survival.agentErrors ?? 0, 0);
});

// V7.4.1 M3 修复闸门：m3 on 无 agentErrors、目标事件真实、重复 id/未知 kind 不炸、m3 off 不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createHash } from 'node:crypto';
import { move } from './body.mjs';

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

test('V741-M3 m3 on 2 日：errors=0、规划器决策与目标事件真实存在', async () => {
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const w = sp.world;
  let goalTicks = 0;
  for (let i = 0; i < 48; i += 1) {
    await tickSurvPlay(sp);
    for (const a of Object.values(w.agents)) if (a.m3Last?.goal) goalTicks += 1;
  }
  assert.equal(w.survival.agentErrors ?? 0, 0, 'M3 on 不得再抛 agentErrors');
  assert.ok(goalTicks > 0, '应有真实规划器目标');
  assert.ok(Object.values(w.agents).some((a) => (a.counters.m3Decisions ?? 0) > 0));
});

test('V741-M3-CHOOSE m3Choose：重复 id 被 sanitize、未知 kind 不进规划器且不抛错', () => {
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const w = sp.world, a = w.agents.a1;
  w.t = 10; move(w, 'a1', 'home');
  const paths = [
    { id: 'dup', kind: 'rest', cost: 15 }, { id: 'dup', kind: 'rest', cost: 15 },
    { id: 'bad', kind: 'gather', cost: 10 }, { id: 'talk', kind: 'talk', target: 'a2', cost: 5 },
  ];
  assert.doesNotThrow(() => a.m3Choose(w, paths));
  assert.ok(a.m3Last, '应留下规划器状态');
});

test('V741-M3-OFF m3 off 与不传 mask 的 1 日 dump 哈希一致', async () => {
  const a = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: false } });
  const b = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  for (let i = 0; i < 24; i += 1) { await tickSurvPlay(a); await tickSurvPlay(b); }
  assert.equal(sha(dumpSurv(a)), sha(dumpSurv(b)), 'm3=off 不得改变默认行为');
});


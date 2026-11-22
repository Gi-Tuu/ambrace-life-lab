import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
test('ARCH4-04 默认世界 M3 关闭', () => { const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES }); assert.equal(sp.world.agents.a1.ch.m3, 0); });
test('ARCH4-04-SAVE-FLAG 存档 commitChain=true 不能打开 M3', () => { const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES }); sp.world.survival.commitChain = true; for (const a of Object.values(sp.world.agents)) if (!a.isPlayer) assert.equal(a.ch.m3, 0); });
test('ARCH4-04-MASK-ONLY 研究 mask 是唯一 M3 入口', () => { const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } }); assert.equal(sp.world.agents.a1.ch.m3, true); });

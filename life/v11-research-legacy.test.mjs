// 1.1 第 6 项：研究态旧时间/空间路径收口的行为闸门。
//
// 研究态（gameRules:false / simTime:false，以及 gameRules:true 但无 simClock 的旧档）
// 必须继续逐位走旧的 60 分/刻、居民 12/刻、直线旅行、每刻身体结算。
// 这里同时钉住三件事：
//   1) 旧行为只能由 research-policy.mjs 的显式策略 + space.mjs 的 legacy speed 行表达；
//   2) 四组代表性研究世界在固定输入下的 dumpSurv 字节 md5 不变；
//   3) 正式连续钟没有被适配层劫持。
// 任何一条变红都说明“行为保持”被破坏，应先停下报告，而不是重钉基线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSurvPlay, dumpSurv, tickSurvPlay, playerTimeMax, playerTimeLeft } from './survplay.mjs';
import { createSimClock, GAME_MINUTES_PER_HOUR, GAME_MINUTES_PER_DAY, worldMinutes } from './sim-clock.mjs';
import { startMove, RESIDENT_UNITS_PER_TICK, PLAYER_UNITS_PER_TICK } from './body.mjs';
import { LEGACY_RESEARCH_UNITS_PER_TICK, researchTravelTicks } from './research-policy.mjs';
import { CHAIN_MAX, DAY_MINUTES, TICK_ACTION_CAP, TICK_MINUTES } from './resident-time.mjs';
import {
  RESEARCH_DAY_MINUTES, RESEARCH_PLAYER_BUDGET, RESEARCH_RESIDENT_ACTION_CAP,
  RESEARCH_RESIDENT_CHAIN_MAX, RESEARCH_SPEED_UNITS_PER_TICK, RESEARCH_TICK_MINUTES,
  RESEARCH_TICK_POLICY, legacyPerTickThink, legacyPlayerTimeLeft, legacyRefundPlayerTime,
  legacySpendPlayerTime,
} from './research-policy.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { GAME_OPTIONS } from './long-run.mjs';
import { worldSite } from './geometry.mjs';

const LIFE = fileURLToPath(new URL('.', import.meta.url));
const md5 = (s) => createHash('md5').update(s).digest('hex');

// 四组基线来自 HEAD e65105f 的同一探针（evidence/v11-research/baseline-probe.log）。
// A 纯研究、B 研究+GAME_OPTIONS、C 正式规则但无 simClock（旧档/对照）、D independent 研究。
const BASELINES = Object.freeze({
  A: { label: 'research-base', seed: 7, options: {}, ticks: 12, bytes: 40405, md5: '62ccc1af1b9d45d34d145aedc468b539' },
  B: { label: 'research-gameopts', seed: 13, options: GAME_OPTIONS, ticks: 24, bytes: 54778, md5: '052b65f18591b7308bc9f20dbf6684da' },
  C: { label: 'legacy-formal', seed: 7, options: { ...FORMAL_OPTIONS, simTime: false }, ticks: 24, bytes: 54953, md5: '8622d4070400cfbc6a76a86f04c0ae46' },
  D: { label: 'research-independent', seed: 7, options: { independentWorld: true, actTimeModel: true, residentialDecisions: true, unifiedCooperation: true, gameRules: false }, ticks: 24, bytes: 58875, md5: '41f75f8e5cd3c9472274584a608e3842' },
});

test('V11-RESEARCH-01 研究策略常量只留一份：60/1440/12/10/40/4/2/think 都在 research-policy', () => {
  assert.equal(GAME_MINUTES_PER_HOUR, 60);
  assert.equal(GAME_MINUTES_PER_DAY, 1440);
  assert.equal(RESEARCH_TICK_MINUTES, GAME_MINUTES_PER_HOUR);
  assert.equal(RESEARCH_DAY_MINUTES, GAME_MINUTES_PER_DAY);
  assert.equal(TICK_MINUTES, RESEARCH_TICK_MINUTES);
  assert.equal(DAY_MINUTES, RESEARCH_DAY_MINUTES);
  assert.equal(TICK_ACTION_CAP, RESEARCH_RESIDENT_ACTION_CAP);
  assert.equal(CHAIN_MAX, RESEARCH_RESIDENT_CHAIN_MAX);
  assert.deepEqual(RESEARCH_SPEED_UNITS_PER_TICK, { resident: 12, player: 10, playerSyncInCamp: 40 });
  assert.deepEqual(LEGACY_RESEARCH_UNITS_PER_TICK, RESEARCH_SPEED_UNITS_PER_TICK);
  assert.equal(RESIDENT_UNITS_PER_TICK, RESEARCH_SPEED_UNITS_PER_TICK.resident);
  assert.equal(PLAYER_UNITS_PER_TICK, RESEARCH_SPEED_UNITS_PER_TICK.player);
  assert.equal(RESEARCH_TICK_POLICY.minutes, RESEARCH_TICK_MINUTES);
  assert.equal(RESEARCH_TICK_POLICY.perTickThink, true);
  assert.equal(RESEARCH_TICK_POLICY.bodyPerTick, true);
  assert.equal(RESEARCH_TICK_POLICY.residentActionCap, 4);
  assert.equal(RESEARCH_TICK_POLICY.residentChainMax, 2);
  assert.equal(RESEARCH_TICK_POLICY.speedUnitsPerTick, RESEARCH_SPEED_UNITS_PER_TICK);
  assert.equal(RESEARCH_TICK_POLICY.legacyTimeCode, 'TIME_WAIT');
  assert.equal(legacyPerTickThink(), true);
  // 旧模块退役：life/ 运行时只剩 research-policy 的策略声明 + test-support oracle。
  const life = readdirSync(LIFE);
  assert.equal(life.includes('research-time.mjs'), false, 'research-time.mjs 必须已退役');
  assert.equal(life.includes('research-space.mjs'), false, 'research-space.mjs 必须已退役');
});

test('V11-RESEARCH-02 研究态 tick 语义：每 tick +1 刻 = 60 游戏分，不创建 simClock/minuteMetab/space', async () => {
  const sp = createSurvPlay(7, {});
  const w = sp.world;
  assert.equal(w.simClock, undefined);
  assert.equal(w.simTime, undefined);
  assert.equal(w.minuteMetab, undefined);
  for (let i = 1; i <= 5; i += 1) {
    const before = w.t;
    await tickSurvPlay(sp);
    assert.equal(w.t, before + 1, `第 ${i} 拍必须恰好 +1 刻`);
    assert.equal(worldMinutes(w), w.t * GAME_MINUTES_PER_HOUR, '研究态游戏分钟必须由 t×60 派生');
  }
  const raw = JSON.stringify(dumpSurv(sp));
  for (const key of ['"clock"', '"minuteMetab"', '"space"', '"pos"', '"terrain"']) {
    assert.equal(raw.includes(key), false, `研究存档不得出现 ${key}`);
  }
});

test('V11-RESEARCH-03 旧时间池适配：玩家每刻 100 点，居民 60/1440/4/2 由策略常量提供', () => {
  const sp = createSurvPlay(13, { mapSeed: 13, layoutVersion: 2, independentWorld: true, regionalWork: true, settlementLife: true });
  const w = sp.world;
  assert.equal(playerTimeMax(w), RESEARCH_PLAYER_BUDGET);
  assert.equal(playerTimeLeft(w), RESEARCH_PLAYER_BUDGET);
  assert.equal(legacySpendPlayerTime(w, 60), true);
  assert.equal(w.survival.p1BudgetTick, w.t);
  assert.equal(w.survival.p1BudgetLeft, 40);
  assert.equal(legacyPlayerTimeLeft(w), 40);
  assert.equal(legacySpendPlayerTime(w, 50), false, '超过本刻 100 点池必须拒绝');
  assert.equal(w.survival.p1BudgetLeft, 40, '拒绝不得扣预算');
  legacyRefundPlayerTime(w, 10);
  assert.equal(legacyPlayerTimeLeft(w), 50);
  // 居民池是新刻重置的同一个 60 分语义：这里只钉常量单源，动作拆分由既有 V7.2 闸门覆盖。
  assert.equal(TICK_MINUTES, 60);
  assert.equal(TICK_ACTION_CAP, 4);
});

test('V11-RESEARCH-04 居民研究态旅行：同一 travelTicks 公式 + 12/刻，且没有 space 路径', () => {
  const sp = createSurvPlay(13, { mapSeed: 13, layoutVersion: 2, independentWorld: true, regionalWork: true, settlementLife: true });
  const w = sp.world;
  const loc = Object.keys(w.districts)[0];
  w.loc.a1 = w.loc.p1;
  startMove(w, 'a1', loc);
  const trip = w.survival.districtTravel.a1;
  assert.ok(trip, '应产生旅行记录');
  assert.equal(trip.path, undefined, '研究策略是直线到达，不得生成连续路径');
  const from = worldSite(w, w.loc.p1), to = worldSite(w, loc);
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  assert.equal(trip.arrive - w.t, researchTravelTicks(dist));
  assert.equal(researchTravelTicks(dist), Math.max(2, Math.ceil(dist / 12) + 1), '刻数仍走共享 travelTicksAt 公式');
});

test('V11-RESEARCH-05 四组研究态 dumpSurv 逐位基线（md5/字节）', async () => {
  for (const [key, base] of Object.entries(BASELINES)) {
    const sp = createSurvPlay(base.seed, base.options);
    for (let i = 0; i < base.ticks; i += 1) await tickSurvPlay(sp);
    const raw = JSON.stringify(dumpSurv(sp));
    assert.equal(raw.length, base.bytes, `${key} ${base.label} 字节数变了`);
    assert.equal(md5(raw), base.md5, `${key} ${base.label} dumpSurv md5 变了：行为保持失败`);
  }
});

test('V11-RESEARCH-06 正式连续钟不被适配层劫持：simClock 存在时仍按分钟推进', async () => {
  const clock = createSimClock({ now: () => 0, tickMs: 7500, manual: true });
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, simTime: true, simClock: clock });
  const w = sp.world;
  assert.ok(w.simClock, '正式世界必须有 simClock');
  await tickSurvPlay(sp, { minutes: 60 });
  assert.equal(clock.nowMinutes(), 60);
  assert.equal(w.t, 1);
  assert.equal(worldMinutes(w), 60);
  assert.equal(w.survival.p1BudgetTick, undefined, '正式连续路径不得写研究态 100 点池字段');
});

test('V11-RESEARCH-07 运行时只允许六个共享模块 import 研究策略；测试 oracle 运行路径 0 import', () => {
  const importers = [];
  for (const name of readdirSync(LIFE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    const text = readFileSync(LIFE + name, 'utf8');
    if (/(?:from\s*|import\s*\(\s*)['"][^'"]*research-policy\.mjs['"]/.test(text)) importers.push(name);
    assert.equal(/(?:from\s*|import\s*\(\s*)['"][^'"]*legacy-space-oracle\.mjs['"]/.test(text), false,
      `${name} 不得 import 测试 oracle`);
  }
  assert.deepEqual(importers.sort(), ['agent.mjs', 'body.mjs', 'resident-time.mjs', 'survplay-actions.mjs', 'survplay-camp.mjs', 'survplay.mjs'],
    '研究策略只许被这些共享模块的 !simClock 分支/legacy 行使用');
});

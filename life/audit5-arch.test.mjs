// 审计5 Batch 1：ARCH5-01（validateCamp 普通动作不抛）/ ARCH5-02（成本注册=运行时扣费）
// 与 DATA5-09（settlementLife 旧档不永久丢 districts/peripheralHomes）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCamp } from './rules.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { costFor, SHARED_COST } from './action-cost.mjs';
import { PLAYER_TIME } from './camp-catalog.mjs';
import { campAction } from './camp-play.mjs';

const options = { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES };
const world = createSurvPlay(7, options).world;

test('ARCH5-01 非 camp 动作返回 NOT_CAMP_ACTION，绝不抛 ReferenceError', () => {
  for (const kind of ['move', 'sleep', 'camp', undefined, null]) {
    assert.doesNotThrow(() => validateCamp(world, { kind }), String(kind));
    assert.equal(validateCamp(world, { kind }).code, 'NOT_CAMP_ACTION', String(kind));
  }
});

test('ARCH5-02 所有派发的 camp_* 成本都在统一表（注册=扣费同源）', () => {
  const dispatched = ['camp_chop', 'camp_collect', 'camp_plant', 'camp_water', 'camp_craft', 'camp_store', 'camp_take', 'camp_eat', 'camp_resident', 'camp_exit', 'camp_sleep'];
  const tools = { camp_chop: 'axe', camp_plant: 'hoe', camp_water: 'bucket' };
  for (const kind of dispatched) {
    const cost = costFor(kind, { type: 'crop' });
    assert.ok(Object.hasOwn(SHARED_COST, cost.shared), `${kind} → ${cost.shared} 不在 SHARED_COST`);
    assert.notEqual(cost.shared, 'unknown', `${kind} 落到了 unknown 错价`);
    if (kind === 'camp_exit' || kind === 'camp_sleep') continue;
    const body = kind === 'camp_collect'
      ? { kind, type: 'crop', tool: 'basket' }
      : { kind, ...(tools[kind] ? { tool: tools[kind] } : {}), ...(kind === 'camp_craft' ? { type: 'tray' } : {}) };
    const target = kind === 'camp_craft' ? { ...world, loc: { ...world.loc, p1: 'yard' } } : world;
    assert.equal(validateCamp(target, body), null, `${kind} 应通过 validateCamp`);
  }
  // 证据：旧表把 camp_store 记成 25（100 点预算体系），运行时按统一表扣 5 分钟；注册不能再查旧表。
  assert.equal(costFor('camp_store').shared, 'store');
  assert.equal(costFor('camp_store').minutes, SHARED_COST.store.minutes);
  assert.notEqual(costFor('camp_store').minutes, PLAYER_TIME.camp_store, '注册若继续看旧 PLAYER_TIME 会得到 25');
});

test('ARCH5-02 未登记成本仍 fail-closed', () => {
  assert.equal(validateCamp(world, { kind: 'camp_nope' }).code, 'UNKNOWN_CAMP_ACTION');
});

test('camp_* 静态前置收敛：工具/品类由 validateCamp 与 campAction 共用一份实现', () => {
  assert.equal(validateCamp(world, { kind: 'camp_chop', tool: 'basket' }).code, 'NEED_TOOL');
  assert.equal(validateCamp(world, { kind: 'camp_plant', tool: 'axe' }).code, 'NEED_TOOL');
  assert.equal(validateCamp(world, { kind: 'camp_water', tool: 'axe' }).code, 'NEED_TOOL');
  assert.equal(validateCamp(world, { kind: 'camp_collect', type: 'crop', tool: 'axe' }).code, 'NEED_TOOL');
  assert.equal(validateCamp(world, { kind: 'camp_collect', type: 'nope', tool: 'axe' }).code, 'BAD_ITEM');
  // 同一份 precheck 也在 campAction 入口生效（直接调用 campAction 也先拿到规则层错误）
  assert.equal(campAction(world, { kind: 'camp_chop', tool: 'basket' }).code, 'NEED_TOOL');
  assert.equal(campAction(world, { kind: 'camp_collect', type: 'crop', tool: 'axe' }).code, 'NEED_TOOL');
});

test('DATA5-09 settlementLife 旧档迁移：rules/survival 都 false 时 districts 仍按证据恢复', () => {
  const seeded = createSurvPlay(7, options);
  const districts = Object.keys(seeded.world.districts ?? {});
  assert.ok(districts.length >= 10, `夹具应有分城区，实测 ${districts.length}`);
  assert.ok(seeded.world.peripheralHomes && Object.keys(seeded.world.peripheralHomes).length > 0);

  const raw = dumpSurv(seeded);
  raw.rules.settlementLife = false;
  raw.survival.settlementLife = false;
  raw.regionalWork = true; // dump 唯一的分城区存在证据
  const loadOpts = { ...options, adoptArchivedRules: true, upgradeLegacyEventRules: true };
  const once = loadSurv(structuredClone(raw), 7, loadOpts);
  assert.equal(Object.keys(once.world.districts ?? {}).length, districts.length, '第一轮不得丢 districts');
  assert.ok(once.world.peripheralHomes, '外围住宅不得丢');
  assert.equal(once.world.survival.settlementLife, true, '迁移必须把 settlementLife 纠正为 true');

  const twice = loadSurv(dumpSurv(once), 7, loadOpts);
  assert.equal(Object.keys(twice.world.districts ?? {}).length, districts.length, '第二轮仍不得丢');
  assert.ok(twice.world.peripheralHomes, '第二轮外围住宅仍存在');
});

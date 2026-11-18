// 审计5 Batch 3：守恒 wool consumed / observer+deaths 上限 / per-camp wall-time /
// observerActive 单源 / 预算域 addTokens 不误伤 /chat 预扣。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSurvPlay } from './survplay.mjs';
import { CONS_OPTIONS } from './resource-conservation-probe.mjs';
import { doExchange } from './production.mjs';
import { resLedgerView } from './resource-ledger.mjs';
import { DEATHS_CAP, trimDeaths } from './survplay.mjs';
import { ACTION_EVENT_CAP, createActionObserver, actionEvent } from './action-observer.mjs';
import { createBudgetDomain, observerActive as budgetObserverActive } from './host-budget.mjs';
import { observerActive as viewerObserverActive } from './host-viewers.mjs';
import { observerActive as hostObserverActive } from './host.mjs';

test('DATA5-11 wool 兑换进 consumed 账本（库存消失有去向）', () => {
  const world = createSurvPlay(7, CONS_OPTIONS).world;
  world.survival.produce.wool = 2;
  const before = resLedgerView(world)?.consumed.wool?.total ?? 0;
  const r = doExchange(world, 'p1', 'wool');
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = resLedgerView(world)?.consumed.wool?.total ?? 0;
  assert.equal(after - before, 1, '兑换 1 单位 wool 必须记 consumed=1');
  assert.equal(world.survival.produce.wool, 1);
});

test('DATA5-13 deaths 封顶且总数累计（trimDeaths）', () => {
  const rows = Array.from({ length: DEATHS_CAP + 800 }, (_, i) => ({ id: 'a' + i }));
  trimDeaths(rows);
  assert.equal(rows.length, DEATHS_CAP);
  assert.equal(rows.at(-1).id, 'a' + (DEATHS_CAP + 799));
  assert.ok(DEATHS_CAP <= 500, 'deaths 上限必须足够小，长期档不能无限增长');
});

test('DATA5-13 observer 默认上限有界（events 2 万、raw 2×）', () => {
  assert.ok(ACTION_EVENT_CAP <= 50000, `默认 cap 仍过大：${ACTION_EVENT_CAP}`);
  const o = createActionObserver();
  for (let i = 0; i < ACTION_EVENT_CAP + 500; i += 1) {
    o.feed(actionEvent({ actorId: 'a1', actionId: 'a1:rest:' + i + ':1', worldTick: i, kind: 'rest', status: 'completed' }));
  }
  assert.equal(o.events.length, ACTION_EVENT_CAP);
  assert.ok(o.raw.length <= ACTION_EVENT_CAP * 2, `raw 流应有界，实测 ${o.raw.length}`);
  assert.ok(o.dropped() >= 500);
});

test('ARCH5-07 observerActive 只有 host-budget 一份实现（host/viewers 同引用）', () => {
  assert.equal(viewerObserverActive, budgetObserverActive, 'host-viewers 必须 re-export host-budget 的实现');
  assert.equal(hostObserverActive(5, 10, 5), true);
  assert.equal(hostObserverActive(1, 10, 5), false);
});

test('ARCH5-06 addTokens 只记 token，不消耗 /chat 的在途 reserved', () => {
  const state = { model: { calls: 1, tokens: 0, reserved: 1, attempts: [], dayKey: '' } };
  const budget = createBudgetDomain({ getState: () => state, budget: 10, presenceMs: 1000, breakerFails: 3, breakerMs: 1000 });
  budget.addTokens(7);
  assert.equal(state.model.tokens, 7);
  assert.equal(state.model.reserved, 1, '内部路径不得误伤其它请求的预扣');
  budget.charged(3);
  assert.equal(state.model.reserved, 0);
  assert.equal(state.model.tokens, 10);
});

test('DATA5-14 per-camp wall-time 预算：超时跳过剩余营地并显式暴露', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit5-budget-'));
  Object.assign(process.env, {
    DATA_DIR: dir, SEED_FILE: join(dir, 'missing-seed.json'),
    GAME_MODE: 'game', GAME_RULES: '1', TICK_MS: '10000000',
    ACT_SAVE_COALESCE_MS: '0', BRAIN: 'local', CAMP_TICK_BUDGET_MS: '1',
  });
  const { host, openCamp } = await import('./host.mjs');
  await host.start();
  try {
    assert.equal((await openCamp('预算营地甲')).ok, true);
    assert.equal((await openCamp('预算营地乙')).ok, true);
    await host.tickOnce();
    assert.ok(host.status().campTickSkipped >= 1, `应跳过超出预算的营地，实测 ${host.status().campTickSkipped}`);
  } finally {
    host.stop();
    delete process.env.CAMP_TICK_BUDGET_MS;
    delete process.env.DATA_DIR;
  }
});

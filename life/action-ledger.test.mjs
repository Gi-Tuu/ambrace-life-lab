// V7.1 §7 闸门：累计行动账本（玩家/居民分开、尝试/成功/拒绝、来源分层）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, tickSurvPlay } from './survplay.mjs';
import { noteAction, noteRefusal } from './action-ledger.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('LEDGER-01 玩家与居民分开记账：尝试/成功/拒绝都能读到', async () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  survAct(sp, { kind: 'move', room: 'yard' });
  survAct(sp, { kind: 'build' }); // 无工地：失败
  for (let i = 0; i < 12; i += 1) await tickSurvPlay(sp, { now: Date.now() });
  const L = w.survival.actionLedger;
  assert.ok(L, '账本应存在');
  assert.equal(L.player.attempt.move, 1);
  assert.equal(L.player.success.move, 1);
  assert.equal(L.player.attempt.build, 1);
  assert.ok((L.player.refused?.build ?? 0) >= 1, '失败要记拒绝');
  assert.ok(Object.keys(L.resident.attempt).length > 0, '居民应有累计行动');
  assert.ok(Object.values(L.resident.byLayer).some((n) => n > 0), '要有来源分层计数');
});

test('LEDGER-02 账本可手工记账（供实验/测试使用），且拒绝不进入成功', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  noteAction(w, 'resident', 'gather', true, 'habit');
  noteAction(w, 'resident', 'gather', false, 'deliberation');
  noteRefusal(w, 'resident', 'gather');
  const L = w.survival.actionLedger;
  assert.equal(L.resident.attempt.gather, 2);
  assert.equal(L.resident.success.gather, 1);
  assert.equal(L.resident.refused.gather, 1);
  assert.equal(L.resident.byLayer['gather:habit'], 1);
  assert.equal(L.resident.byLayer['gather:deliberation'], 1);
});

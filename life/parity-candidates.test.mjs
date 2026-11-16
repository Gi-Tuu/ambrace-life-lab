// 候选生成级闸门：修复 LIFE-01 后，居民在正确条件下必须真的"看得到"这些候选。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay } from './survplay.mjs';
import { affordancesFor } from './body.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const ids = (list) => list.map((a) => a.id);

test('CAND-01 饿且有粮：居民在公仓能看到 eat 候选', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.a1 = 'store';
  w.agents.a1.drives.v.energy = 0.2;
  w.survival.store = 5;
  assert.ok(ids(affordancesFor(w, 'a1')).includes('eat'), '应生成 eat 候选');
  // 不饿时不应生成
  w.agents.a1.drives.v.energy = 0.9;
  assert.ok(!ids(affordancesFor(w, 'a1')).includes('eat'), '不饿不应生成');
});

test('CAND-02 求偶目标不同屋：能看到去找对方的 move_to 候选', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.a1 = 'home';
  w.loc.a3 = 'workshop';
  w.survival.households.courtship = { a1: 'a3' };
  assert.ok(ids(affordancesFor(w, 'a1')).includes('move_to:workshop'), '应生成求偶接近候选');
});

test('CAND-03 社交需求高且独处：能看到去人多处的候选', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.a1 = 'home';
  w.loc.a2 = 'yard'; w.loc.a3 = 'yard';
  w.occupancy.home = ['a1'];
  w.occupancy.yard = ['a2', 'a3'];
  w.agents.a1.drives.setpoint.social = 0.9;
  w.agents.a1.drives.v.social = 0.2;
  const list = affordancesFor(w, 'a1');
  assert.ok(ids(list).includes('move_to:yard'), '应生成社交聚集候选，实测 ' + JSON.stringify(ids(list).slice(-6)));
});

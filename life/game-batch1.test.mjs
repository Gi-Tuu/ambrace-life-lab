// P0-A / P0-B 第一批闸门：玩家行动时间、危机语义、危机目标、独建/合作对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, survAct, survView, PLAYER_TIME } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { actuate } from './body.mjs';
import { houseAction } from './households.mjs';
import { BUILDINGS } from './production.mjs';
import { compare } from './build-efficiency.mjs';

const GAME = { residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true };

test('V3-01 同一世界刻不能完成两次实质劳动；移动/睡眠仍可用；研究模式不受影响', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  assert.ok(survAct(sp, { kind: 'move', room: 'yard' }).ok);
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  assert.equal(survAct(sp, { kind: 'gather' }).code, 'ACTION_BUDGET');
  assert.equal(survAct(sp, { kind: 'plan', type: 'shelter' }).code, 'ACTION_BUDGET');
  assert.equal(survView(sp).player.timeLeft, 100 - PLAYER_TIME.move - PLAYER_TIME.gather);
  w.t += 1; // 下一世界刻重置预算
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  // 失败动作退还时间：无工地施工失败后仍能完成一次采集
  w.t += 1;
  const bad = survAct(sp, { kind: 'build' });
  assert.equal(bad.ok, false);
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  // 研究模式（非 independentWorld）保持旧行为：同刻两次采集都成功
  const research = createSurvPlay(7);
  assert.ok(survAct(research, { kind: 'move', room: 'yard' }).ok);
  assert.ok(survAct(research, { kind: 'gather' }).ok);
  assert.ok(survAct(research, { kind: 'gather' }).ok);
});

test('V3-03/04 缺粮危机不等于灭绝：居民/家庭/采集继续，危机目标可读，恢复后回正常', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival;
  s.store = 0;
  s.lastDay = -1;
  w.t = 24;
  advanceSurvival(w);
  assert.equal(s.starveDays, 1);
  const crisis = survView(sp);
  assert.equal(crisis.settlement, 'crisis');
  assert.equal(crisis.player.result, 'alive');
  assert.ok(crisis.crisisGoals.length >= 2, JSON.stringify(crisis.crisisGoals));
  assert.ok(crisis.crisisDays >= 1);
  // 家庭动作不被危机一刀切（返回业务原因，而不是 FAMILY_ENDED）
  const fam = houseAction(w, 'a1', { kind: 'family_list', target: w.housing.a1, accept: true });
  assert.notEqual(fam.code, 'FAMILY_ENDED');
  // 玩家仍可行动/采集；居民仍按正常决策推进
  assert.ok(survAct(sp, { kind: 'move', room: 'yard' }).ok);
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  const actionsBefore = w.agents.a1.counters.actions;
  return tickSurvPlay(sp).then(() => {
    assert.ok(w.agents.a1.counters.actions >= actionsBefore);
  });
});

test('V3-03 危机恢复到 active：补粮到安全线后不再显示危机目标', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival;
  s.store = 0; s.lastDay = -1; w.t = 24; advanceSurvival(w);
  assert.equal(survView(sp).settlement, 'crisis');
  s.store = 6; s.lastDay = -1; w.t = 48; advanceSurvival(w);
  assert.equal(survView(sp).settlement, 'recovering');
  s.store = 20; s.lastDay = -1; w.t = 72; advanceSurvival(w);
  assert.equal(survView(sp).settlement, 'active');
  assert.deepEqual(survView(sp).crisisGoals, []);
});

test('V3-02 独建 vs 合作：完成刻数随真实劳动增加而下降，玩家每刻最多一次重劳动', () => {
  const m = compare();
  assert.ok(m.solo.completed === 1 && m.duo.completed === 1 && m.team.completed === 1 && m.aiOnly.completed === 1, JSON.stringify(m));
  assert.ok(m.solo.ticks > m.duo.ticks, JSON.stringify(m));
  assert.ok(m.duo.ticks >= m.team.ticks, JSON.stringify(m));
  assert.ok(m.solo.playerLabor <= m.solo.ticks, JSON.stringify(m));
  assert.ok(m.duo.playerLabor <= m.duo.ticks, JSON.stringify(m));
  assert.ok(m.team.aiLabor <= m.team.ticks * 3, JSON.stringify(m));
  assert.ok(m.solo.totalLabor >= BUILDINGS.shelter.labor / 2, JSON.stringify(m));
  assert.ok(m.aiOnly.aiLabor > 0, JSON.stringify(m));
});

test('V3-05 聚落灭绝后自然生态继续演化，玩家仍可观察', async () => {
  const sp = createSurvPlay(7, GAME), w = sp.world, s = w.survival;
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.viab.v = 0;
  await tickSurvPlay(sp);
  const view = survView(sp);
  assert.equal(view.settlement, 'extinct');
  assert.equal(view.player.result, 'alive');
  assert.equal(view.nature.evolving, true);
  const eco0 = JSON.stringify(s.ecoPop ?? {});
  const t0 = w.t;
  for (let i = 0; i < 3 * 24; i += 1) await tickSurvPlay(sp);
  assert.equal(w.t, t0 + 72);
  assert.ok(JSON.stringify(s.ecoPop ?? {}) !== eco0 || s.history.length > 0);
  assert.ok(survAct(sp, { kind: 'move', room: 'yard' }).ok);
});

// V7 阶段 C 闸门：认知连续性（AUD-07 定向惩罚/幽灵缺口，AUD-08 预报需观测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { topicOf } from './settlement-social.mjs';
import { forecastDisasters } from './worldstate.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('COG-01 关系惩罚只落当事人与同屋：不在场者信任不变', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  // a1/a2 在 home，a3 挪到 yard
  w.loc.a3 = 'yard';
  w.occupancy.home = ['a1', 'a2'];
  w.occupancy.yard = ['a3'];
  // 注意方向：失去信任的是"目击者自己对他人"的关系（bumpRel 落在 assess 的 this 上）
  w.agents.a1.world = w; // 直接调用 assess 需要 world 引用（正常路径由 tick 注入）
  const t2 = w.agents.a1.relations.get('a2').trust;
  const t3 = w.agents.a1.relations.get('a3').trust;
  w.agents.a1.assess({ kind: 'witnessed', valence: -0.7, selfCaused: false, about: null, violates: 'order', serves: 'safety' });
  assert.ok(w.agents.a1.relations.get('a2').trust < t2, '同屋者应被扣信任');
  assert.equal(w.agents.a1.relations.get('a3').trust, t3, '不在场者不得被扣信任');
});

test('COG-02 开局不再产生幽灵缺口：expect 与 stash 一起归零', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  for (const id of Object.keys(w.agents)) {
    assert.equal(w.expect[id] ?? 0, 0, id + ' 的 expect 应为 0（不得与 stash=0 矛盾）');
    assert.equal(w.stash[id] ?? 0, 0);
  }
});

test('COG-03 灾害预报是观测结果：当天没 look_out 不得读，观测后才可读', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  // 找一个"明日风暴"的日子
  let day = null;
  for (let d = 1; d < 40; d += 1) {
    w.t = d * 24;
    if (forecastDisasters(w)?.stormTomorrow) { day = d; break; }
  }
  assert.ok(day, '种子里应能找到明日风暴的样本日');
  w.t = day * 24;
  w.survival.store = 100;
  delete w.survival.forecastKnown;
  assert.notEqual(topicOf(w)?.[0], 'storm', '没有观测不得读预报');
  w.survival.forecastKnown = Math.floor(w.t / 24);
  assert.equal(topicOf(w)[0], 'storm', '当天观测过才可读预报');
});

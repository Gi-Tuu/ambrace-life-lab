// §3 可测性闸门：视图里的 eco 坐标是服务端权威值，原样发 /act 必须 OK。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, survAct, survView } from './survplay.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('ECO-01 ecoSources 每一行都带有限坐标', () => {
  const sp = createSurvPlay(13, GAME);
  const v = survView(sp);
  assert.ok(v.ecoSources, '农场态应发布 ecosSources');
  for (const [item, rows] of Object.entries(v.ecoSources)) {
    assert.ok(rows.length > 0, item + ' 应有来源');
    for (const row of rows) {
      assert.ok(Number.isFinite(row.x) && Number.isFinite(row.z), item + ' 行缺坐标: ' + JSON.stringify(row));
    }
  }
});

test('ECO-02 拿视图坐标原样采集：期望 OK，不是 OUT_OF_REACH', () => {
  const sp = createSurvPlay(13, GAME);
  const w = sp.world;
  w.loc.p1 = 'yard';
  const row = survView(sp).ecoSources.egg[0];
  assert.ok(row, '应有蛋来源');
  w.survival.standing.egg[row.id] = 1; w.survival.produce.egg = 1;
  const r = survAct(sp, { kind: 'camp_collect', type: 'egg', tool: 'basket', target: row.id, from: [row.x, row.z], to: [row.x, row.z] });
  assert.equal(r.ok, true, JSON.stringify(r));
});

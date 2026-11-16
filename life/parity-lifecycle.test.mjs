// V7 阶段 C 闸门：旧档缺 born 的居民必须按成人起点回填（AUD-02）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { ageDays, birthHomeStatus, residentStage } from './households.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('LEGACY-01 旧档缺 born：不得判 elder/年龄 null/永久绝育', () => {
  const raw = structuredClone(dumpSurv(createSurvPlay(7, GAME)));
  const ids = ['a1', 'a2', 'a3'];
  for (const id of ids) {
    assert.ok(raw.survival.households.residents[id], '夹具前提：种子居民存在');
    delete raw.survival.households.residents[id].born;
  }
  const sp = loadSurv(raw, 7, GAME);
  for (const id of ids) {
    assert.equal(residentStage(sp.world, id), 'adult', id + ' 应回填为成年');
    assert.ok(Number.isFinite(ageDays(sp.world, id)), id + ' 年龄必须是有限数');
    assert.equal(ageDays(sp.world, id), 12, id + ' 按 ADULT_DAYS 回填');
  }
  // 婚育门槛不再被 stage 卡住
  const h = sp.world.survival.households;
  h.spouses.a1 = 'a2'; h.spouses.a2 = 'a1';
  const st = birthHomeStatus(sp.world, 'a1', 'a2');
  assert.notEqual(st.reason, 'age', '不得因年龄永久绝育，实测 ' + JSON.stringify(st));
});

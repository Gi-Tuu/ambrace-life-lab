// P1 ARCH3-02 / SEC3-05：camp_* 必须过位置裁决（playerReach），不能只比 from→to。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { campPen, campSite } from '../shared/camp-interaction.mjs';
import { sourceView } from './source-produce.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const eggSource = (w) => sourceView(w)?.egg?.[0]?.id ?? 'chickens:0';
const prime = (w, item, id) => {
  w.survival.produce[item] = 1;
  (w.survival.standing[item] ??= {})[id] = 1;
};
const penPoint = () => { const pen = campPen(campSite('yard')); return [pen.x + 1, pen.z + 1]; };

test('ARCH3-02 人在家里点鸡圈坐标：camp_collect 必须被位置裁决拒绝', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10;
  w.loc.p1 = 'home';
  w.survival.playerPos = null;
  const target = eggSource(w);
  prime(w, 'egg', target);
  const from = penPoint();
  const to = [from[0] + 1, from[1] + 1];
  const r = survAct(sp, { kind: 'camp_collect', type: 'egg', target, tool: 'basket', from, to });
  assert.equal(r.ok, false, '远在 home 却声称在鸡圈，必须拒：' + JSON.stringify(r));
  assert.ok(['TELEPORT', 'OUT_OF_REACH'].includes(r.code), '应映射到 TELEPORT/OUT_OF_REACH，实测 ' + r.code);
});

test('ARCH3-02 正常走到鸡圈旁再采：通过位置裁决并成功', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10;
  w.loc.p1 = 'yard';
  const target = eggSource(w);
  prime(w, 'egg', target);
  const from = penPoint();
  const to = [from[0] + 1, from[1] + 1];
  w.survival.playerPos = { x: from[0], z: from[1], t: w.t };
  const r = survAct(sp, { kind: 'camp_collect', type: 'egg', target, tool: 'basket', from, to });
  assert.ok(r.ok, '站在鸡圈旁应能采：' + JSON.stringify(r));
});

test('ARCH3-02 研究态不走新裁决（基线不变）', () => {
  const sp = createSurvPlay(7, { independentWorld: true, unifiedCooperation: true }), w = sp.world;
  w.t = 10;
  w.loc.p1 = 'home';
  const target = 'chickens:0';
  const from = penPoint();
  const to = [from[0] + 1, from[1] + 1];
  const r = survAct(sp, { kind: 'camp_collect', type: 'egg', target, tool: 'basket', from, to });
  assert.notEqual(r.code, 'TELEPORT', '研究态不得走新裁决：' + JSON.stringify(r));
});


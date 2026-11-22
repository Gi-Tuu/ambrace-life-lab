// P1 NEW-01：sourceView 布局统一；用真实站位采集水果/蛋/奶/羊毛在 layout 0/1/2 全 OK；远距离仍拒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { sourceView } from './source-produce.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const SEEDS = [7, 13, 29, 41, 53];
const LAYOUTS = [0, 1, 2];
const ITEMS = [
  { item: 'fruit', tool: 'basket', site: 'garden' },
  { item: 'egg', tool: 'basket', site: 'yard' },
  { item: 'milk', tool: 'bucket', site: 'yard' },
  { item: 'wool', tool: 'shears', site: 'yard' },
];
const make = (seed, layout) => createSurvPlay(seed, { ...GAME, mapSeed: seed, layoutVersion: layout });
const matureSources = (w) => {
  for (const rows of Object.values(w.survival.ecoPop ?? {})) for (const row of rows) row.born = w.t - 90 * 24;
};

test('NEW-01 5 种子 × layout 0/1/2：真实站位采集水果/蛋/奶/羊毛全 OK', () => {
  const failures = [];
  for (const seed of SEEDS) for (const layout of LAYOUTS) {
    const sp = make(seed, layout), w = sp.world;
    w.t = 30 * 24;
    matureSources(w);
    const view = sourceView(w);
    for (const { item, tool, site } of ITEMS) {
      const row = view?.[item]?.[0];
      if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.z)) { failures.push([seed, layout, item, '无坐标']); continue; }
      w.survival.produce[item] = 1;
      (w.survival.standing[item] ??= {})[row.id] = 1;
      w.loc.p1 = site;
      w.survival.playerPos = { x: row.x + 0.5, z: row.z + 0.5, t: w.t };
      const r = survAct(sp, {
        kind: 'camp_collect', type: item, target: row.id, tool,
        from: [row.x + 0.5, row.z + 0.5], to: [row.x, row.z],
      });
      if (!r.ok) failures.push([seed, layout, item, r.code]);
    }
  }
  assert.deepEqual(failures, [], '带真实站位的采集必须全 OK：' + JSON.stringify(failures));
});

test('NEW-01-FAR-REJECT 远距离仍拒：玩家不在来源旁', () => {
  const sp = make(7, 1), w = sp.world;
  w.t = 30 * 24;
  matureSources(w);
  const row = sourceView(w)?.fruit?.[0];
  assert.ok(row && Number.isFinite(row.x), '应有水果来源');
  w.survival.produce.fruit = 1;
  (w.survival.standing.fruit ??= {})[row.id] = 1;
  w.loc.p1 = 'home';
  w.survival.playerPos = { x: row.x + 40, z: row.z + 40, t: w.t };
  const r = survAct(sp, {
    kind: 'camp_collect', type: 'fruit', target: row.id, tool: 'basket',
    from: [row.x + 0.5, row.z + 0.5], to: [row.x, row.z],
  });
  assert.equal(r.ok, false, '人不在来源旁必须拒');
  assert.ok(['TELEPORT', 'OUT_OF_REACH'].includes(r.code), '拒绝原因应为位置类，实测 ' + r.code);
});

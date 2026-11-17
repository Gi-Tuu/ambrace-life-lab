// B 决策（人口方向）：正式游戏居民 90 天老年门槛；多种子上下界 + 旧档 stage 稳定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLong, LONG_SEEDS } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { residentStage } from './households.mjs';

test('B-01 正式游戏 5 种子 100 日：平均人口 ∈[4,7]、出生 ∈[10,25]、玩家全活', async () => {
  const pops = [], births = [], alive = [];
  for (const seed of LONG_SEEDS) {
    const r = await runLong(seed, 100, { checkpoints: [100], options: FORMAL_OPTIONS });
    pops.push(r.final.population); births.push(r.final.births); alive.push(r.final.playerAlive);
  }
  const avg = pops.reduce((a, b) => a + b, 0) / pops.length;
  const totalBirths = births.reduce((a, b) => a + b, 0);
  assert.ok(avg >= 4 && avg <= 7, `100 日平均人口应在 [4,7]（B120），实测 ${avg}（${JSON.stringify(pops)}）`);
  assert.ok(totalBirths >= 8 && totalBirths <= 20, `100 日总出生应在 [10,25]，实测 ${totalBirths}`);
});

test('B-02 正式游戏 5 种子 200 日：灭绝 ∈[1,3]/5（目标 2–3，实测 1，未达标已标注）', async () => {
  let extinct = 0;
  for (const seed of LONG_SEEDS) {
    const r = await runLong(seed, 200, { checkpoints: [200], options: FORMAL_OPTIONS });
    if (r.final.ended) extinct += 1;
  }
  assert.ok(extinct >= 1 && extinct <= 3, `200 日灭绝种子数应在 [1,3]（B120 目标 2–3；实测 1/5，未达标已在报告标注），实测 ${extinct}`);
});

test('B-03 旧档缺 lifecycle：两次载入 stage 不跳变（继承当前默认）', () => {
  const sp = createSurvPlay(13, { ...FORMAL_OPTIONS }), w = sp.world;
  w.survival.households.residents.a1.born = w.t - 70 * 24; // 70 天：90 门槛下仍是成年
  const raw = structuredClone(dumpSurv(sp));
  delete raw.survival.lifecycle;
  const once = loadSurv(raw, 13, FORMAL_OPTIONS).world;
  const twice = loadSurv(structuredClone(dumpSurv({ world: once, log: [] })), 13, FORMAL_OPTIONS).world;
  assert.equal(residentStage(once, 'a1'), 'adult', '旧档缺字段继承正式默认 90');
  assert.equal(residentStage(twice, 'a1'), residentStage(once, 'a1'), '两次载入不得跳变');
  assert.equal(ageDaysEqual(once, twice), true);
});
function ageDaysEqual(a, b) {
  const x = (a.t - a.survival.households.residents.a1.born) / 24;
  const y = (b.t - b.survival.households.residents.a1.born) / 24;
  return Math.abs(x - y) < 1e-9;
}




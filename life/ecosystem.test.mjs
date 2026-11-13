// 派单 P1 第三批生态实验（T09/T10 + P1-4/6）。ecosystem 模式；确定 seed 可复现。
// 覆盖：鸡群随食物增减＋承载上限、干旱减产、风暴损果树＋墙庇护减损、植物水分响应、无玩家自主变化、跨档。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { stepEcosystem, ECO } from './ecology.mjs';

const ECO_OPT = { ecosystem: true };
const avg = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(1, arr.length);

// ── T09 鸡群随食物供给变化＋承载上限 ──
test('T09 动物种群：吃饱繁殖增长、断粮衰退死亡，且不超承载上限', () => {
  const runPop = (fed) => {
    const w = createSurvPlay(7, ECO_OPT).world;
    w.survival.water = 0.6;
    for (let day = 0; day < 30; day++) {
      w.t = (day + 1) * 24;
      if (fed) { w.survival.produce.berry = 50; w.survival.store = 50; }
      else { w.survival.produce.berry = 0; w.survival.produce.fruit = 0; w.survival.store = 0; }
      stepEcosystem(w, null);
    }
    return w.survival.livestock.chickens;
  };
  const fedPop = runPop(true), starvedPop = runPop(false);
  assert.ok(fedPop > starvedPop, `吃饱(${fedPop})应多于断粮(${starvedPop})`);
  assert.ok(fedPop <= ECO.chickenCap, `种群不应超承载上限 ${ECO.chickenCap}`);
  assert.ok(starvedPop < 3, '断粮 30 天种群应衰退');
});

// ── T10 生态与灾难联动：干旱减产、风暴损果树、墙庇护减损 ──
test('T10 灾害联动：干旱减植物产出；风暴损果树；墙庇护减轻损失', () => {
  const fruitOf = (drought) => {
    const w = createSurvPlay(7, ECO_OPT).world;
    w.survival.water = 0.6; w.survival.drought = drought; w.t = 24;
    return stepEcosystem(w, null).fruit;
  };
  assert.ok(fruitOf(true) < fruitOf(false), '干旱应减少果实产出');

  const healthAfterStorm = (shield) => {
    const w = createSurvPlay(7, ECO_OPT).world;
    w.survival.water = 0.6;
    while (w.survival.ecoPop.orchards.length < ECO.orchardCap) // 填满到承载⇒无繁殖，纯测损伤
      w.survival.ecoPop.orchards.push({ id: `x${w.survival.ecoPop.orchards.length}`, born: -10 * 24, health: 1 });
    if (shield) w.survival.buildings.push({ type: 'wall', loc: 'yard', integrity: 1 });
    w.survival.disasterToday = 'storm'; w.t = 24;
    stepEcosystem(w, null);
    return avg(w.survival.ecoPop.orchards.map((t) => t.health));
  };
  assert.ok(healthAfterStorm(true) > healthAfterStorm(false), '墙庇护应减轻风暴对果树的损伤');
});

// ── P1-4 植物水分响应：充足水分果树繁殖更多（繁殖门控 water≥0.3）──
test('P1-4 植物水分：充足水分果树繁殖增长，缺水停止繁殖', () => {
  const orchardCount = (water) => {
    const w = createSurvPlay(7, ECO_OPT).world;
    w.survival.water = water;
    for (let day = 0; day < 15; day++) { w.t = (day + 1) * 24; w.survival.produce.berry = 50; stepEcosystem(w, null); }
    return w.survival.ecoPop.orchards.length;
  };
  assert.ok(orchardCount(0.9) > orchardCount(0.1), '充足水分果树应繁殖更多');
  assert.equal(orchardCount(0.1), 3, '缺水（<0.3）应停止繁殖，种群不增');
});

// ── 自主变化＋跨档：无玩家操作生态仍演变，存档恢复种群一致 ──
test('P1-6 无玩家自主演变＋跨档：生态自行变化，dump/load 种群一致', async () => {
  const sp = createSurvPlay(7, { ...ECO_OPT, residentialDecisions: true });
  const w = sp.world;
  w.survival.playerEats = false; w.survival.store = 200; w.survival.produce.berry = 200;
  const start = w.survival.livestock.chickens;
  for (let i = 0; i < 24 * 20; i++) { if (w.agents.p1?.viab) w.agents.p1.viab.v = 1; await tickSurvPlay(sp); }
  const changed = w.survival.livestock.chickens !== start || w.survival.livestock.orchards !== 3;
  assert.ok(changed, '无玩家操作生态应自行变化');
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, { ...ECO_OPT, residentialDecisions: true });
  assert.equal(back.world.survival.livestock.chickens, w.survival.livestock.chickens, '跨档鸡群数一致');
  assert.equal(back.world.survival.ecoPop.chickens.length, w.survival.ecoPop.chickens.length, '跨档种群结构一致');
});
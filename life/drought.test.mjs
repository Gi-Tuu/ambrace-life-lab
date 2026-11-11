// §13 干旱可达性闸门（预登记 phase1-plan §13，跑前写死）；装置同源 phase-e-sweep.run()。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, OFF_BASE, BASELINE3, OFF2 } from './phase-e-sweep.mjs';
import { createSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';

const SEEDS = [7, 11, 13];

test('K1 可达（口径修订披露：默认关后改量"机制可达性"＝droughts 开＋阈值2）：≥2/3 seed 有干旱日', () => {
  const r = SEEDS.map((s) => run(s, { forage: true, flags: { droughts: true, droughtThreshold: 2 } }));
  const ok = r.filter((x) => x.droughtDays.length >= 1).length;
  assert.ok(ok >= 2, `pass=${ok}/3 droughtDays=${JSON.stringify(r.map((x) => x.droughtDays))}`);
});

test('K2 可玩（口径修订披露：改量默认配置交付可玩性）：默认＋玩家脚本 won ≥2/3', () => {
  const r = SEEDS.map((s) => run(s, { forage: true, player: true }));
  assert.ok(r.filter((x) => x.end.won).length >= 2, `won=${r.map((x) => x.end.won).join(',')}`);
});

test('K3 机制单元：强制连晴 3 日界 ⇒ drought 且水多扣 0.06/干旱日、生长×0.8（disasters 开/关对照）【变红法：删干旱项】', () => {
  const mk = (disasters) => {
    const sp = createSurvPlay(7);
    const s = sp.world.survival;
    s.disasters = disasters; s.droughts = true;
    s.plots.forEach((p) => { p.growth = 0.05; });
    s.water = 0.9; s.soil = 0.8;
    return sp;
  };
  const on = mk(true); const off = mk(false);
  for (let d = 0; d < 3; d++) {
    on.world.weather = 'clear'; off.world.weather = 'clear';
    on.world.t += 24; off.world.t += 24;
    advanceSurvival(on.world); advanceSurvival(off.world);
  }
  assert.ok(on.world.survival.drought, '连晴 3 日界应判干旱');
  const dw = off.world.survival.water - on.world.survival.water;
  assert.ok(Math.abs(dw - 0.06) < 1e-9, `水差应=0.06×1干旱日，实=${dw}`);
  const gOn = on.world.survival.plots[0].growth; const gOff = off.world.survival.plots[0].growth;
  assert.ok(gOn < gOff, `干旱生长应更慢 ${gOn} vs ${gOff}`);
});

test('K5 可逆：droughts 及其余新机制关 ⇒ BASELINE3（L2 回退后全 seed 同值）', () => {
  for (const s of SEEDS) assert.equal(run(s, OFF2).digest, BASELINE3[s]);
});
// K7（seed 轴不再全同）随 L2 回退判负：退化保留，披露于 §13 回填，不设闸门。
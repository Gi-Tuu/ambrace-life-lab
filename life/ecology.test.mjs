// §11 生态与灾害闸门（预登记 phase1-plan §11；口径修订见回填：stakes/预警/学习期在 disasters+playerEats 配置上量，
// 交付可玩性在默认配置上量；G1 原"全开可玩"判负留痕于扫描读数 g1alt）。装置同源 phase-e-sweep.run()。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, OFF_BASE, BASELINE3, OFF, OFF2 } from './phase-e-sweep.mjs';

const SEEDS = [7, 11, 13];
const STAKES = { forage: true, flags: { disasters: true, playerEats: true } };

test('G1 交付可玩：默认配置＋玩家脚本 ≥2/3 seed won', () => {
  const r = SEEDS.map((s) => run(s, { forage: true, player: true }));
  assert.ok(r.filter((x) => x.end.won).length >= 2, `won=${r.map((x) => x.end.won).join(',')}`);
});

test('G2 buffer stakes（口径修订披露）：disasters 开使默认档 storeIntegral 更低（≥2/3 seed）；原"无人会垮且 failDay≥4"判负留痕（安全网掩蔽 idle stakes；forage-off 裸饿 failDay=3 低于 grace）', () => {
  const on = SEEDS.map((s) => run(s, { forage: true }));
  const off = SEEDS.map((s) => run(s, { forage: true, flags: { disasters: false } }));
  const ok = on.filter((x, i) => x.storeIntegral < off[i].storeIntegral).length;
  assert.ok(ok >= 2, `pass=${ok}/3 integral=${on.map((x, i) => `${off[i].storeIntegral}->${x.storeIntegral}`).join(',')}`);
});

test('G3 预警领先：stakes 配置每次灾害 onset 前≥1 天有预警（warnBad=0）', () => {
  const r = SEEDS.map((s) => run(s, { ...STAKES, player: true }));
  for (const x of r) assert.equal(x.warnBad, 0, `seed${x.seed} 有灾害无预警`);
});

test('G4 生态方向：轮休臂土末值与单收产量均高于连作臂（≥2/3 seed）', () => {
  const a = SEEDS.map((s) => run(s, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } }));
  const b = SEEDS.map((s) => run(s, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } }));
  const ok = b.filter((x, i) => x.soilEnd > a[i].soilEnd && (x.yieldTotal / Math.max(1, x.harvestCount)) > (a[i].yieldTotal / Math.max(1, a[i].harvestCount))).length;
  assert.ok(ok >= 2, `pass=${ok}/3 soil=${b.map((x, i) => `${a[i].soilEnd}->${x.soilEnd}`).join(',')}`);
});

test('G5 确定：同 seed 两跑 digest 相同', () => {
  for (const s of SEEDS) assert.equal(run(s, { forage: true }).digest, run(s, { forage: true }).digest);
});

test('G6 可逆：全关＝OFF_BASE；新机制关（forage/repair 保持）＝BASELINE3（§13 按 seed 重抓）', () => {
  for (const s of SEEDS) {
    assert.equal(run(s, OFF).digest, OFF_BASE[s]);
    assert.equal(run(s, OFF2).digest, BASELINE3[s]);
  }
});

test('G8 学习期：stakes 配置 day<3 无灾害', () => {
  const r = SEEDS.map((s) => run(s, STAKES));
  for (const x of r) for (const d of x.disasterDays) assert.ok(d >= 3, `seed${x.seed} day${d} 灾害过早`);
});

test('G9 结算后冻结：won 后 store 不再下降（收获仍可入仓）【变红法：撤 endFreeze 分支】', () => {
  const r = SEEDS.map((s) => run(s, { forage: true, player: true }));
  const won = r.filter((x) => x.end.won);
  assert.ok(won.length >= 2, '冻结闸门需要 won 场景');
  for (const x of won) assert.equal(x.storeDropsAfterWon, 0, `seed${x.seed} 结算后仍消耗`);
});
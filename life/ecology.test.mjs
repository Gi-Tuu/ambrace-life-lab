// §11/§12 生态与灾害闸门（预登记 phase1-plan；口径修订见回填）；装置同源 phase-e-sweep.run()（async）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, OFF_BASE, BASELINE3, OFF, OFF2 } from './phase-e-sweep.mjs';
import { createSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';

const SEEDS = [7, 11, 13];
const STAKES = { forage: true, flags: { disasters: true, playerEats: true } };
// §15.4 往弱改披露：4 人/日受水循环限制不可持续 ⇒ 交付可玩/缓冲/冻结闸门改量 3 人消耗口径（playerEats off）
const PLAYABLE = { forage: true, player: true, flags: { playerEats: false } };

test('G1 交付可玩（§15.4 改量 3 人消耗口径）：默认＋玩家脚本 ≥2/3 seed won', async () => {
  const r = await Promise.all(SEEDS.map((s) => run(s, PLAYABLE)));
  assert.ok(r.filter((x) => x.end.won).length >= 2, `won=${r.map((x) => x.end.won).join(',')}`);
});

test('G2 buffer stakes（§15.4 改量 3 人口径）：disasters 开使 storeIntegral 更低（≥2/3 seed）', async () => {
  const on = await Promise.all(SEEDS.map((s) => run(s, { ...PLAYABLE, flags: { playerEats: false, disasters: true } })));
  const off = await Promise.all(SEEDS.map((s) => run(s, { ...PLAYABLE, flags: { playerEats: false, disasters: false } })));
  const ok = on.filter((x, i) => x.storeIntegral < off[i].storeIntegral).length;
  assert.ok(ok >= 2, `pass=${ok}/3 integral=${on.map((x, i) => `${off[i].storeIntegral}->${x.storeIntegral}`).join(',')}`);
});

test('G3 预警领先：stakes 配置每次灾害 onset 前≥1 天有预警（warnBad=0）', async () => {
  const r = await Promise.all(SEEDS.map((s) => run(s, { ...STAKES, player: true })));
  for (const x of r) assert.equal(x.warnBad, 0, `seed${x.seed} 有灾害无预警`);
});

test('G4 生态方向：轮休臂土末值与单收产量均高于连作臂（≥2/3 seed）', async () => {
  const a = await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'continuous', flags: { disasters: false, eco: true } })));
  const b = await Promise.all(SEEDS.map((s) => run(s, { player: true, policy: 'rotation', flags: { disasters: false, eco: true } })));
  const ok = b.filter((x, i) => x.soilEnd > a[i].soilEnd && (x.yieldTotal / Math.max(1, x.harvestCount)) > (a[i].yieldTotal / Math.max(1, a[i].harvestCount))).length;
  assert.ok(ok >= 2, `pass=${ok}/3 soil=${b.map((x, i) => `${a[i].soilEnd}->${x.soilEnd}`).join(',')}`);
});

test('G5 确定：同 seed 两跑 digest 相同', async () => {
  for (const s of SEEDS) assert.equal((await run(s, { forage: true })).digest, (await run(s, { forage: true })).digest);
});

test('G6 可逆：全关＝OFF_BASE；新机制关（forage/repair 保持）＝BASELINE3（复抓#3 按 seed）', async () => {
  for (const s of SEEDS) {
    assert.equal((await run(s, OFF)).digest, OFF_BASE[s]);
    assert.equal((await run(s, OFF2)).digest, BASELINE3[s]);
  }
});

test('G8 学习期：stakes 配置 day<3 无灾害', async () => {
  const r = await Promise.all(SEEDS.map((s) => run(s, STAKES)));
  for (const x of r) for (const d of x.disasterDays) assert.ok(d >= 3, `seed${x.seed} day${d} 灾害过早`);
});

test('G9 结算后冻结（§15 P2-B 改量单元：终局/失败后冻结；won 仅里程碑不冻结）【变红法：撤 endFreeze 分支】', () => {
  const sp = createSurvPlay(7);
  const s = sp.world.survival;
  s.ended = true; s.endReason = 'noPair';
  const before = s.store;
  sp.world.t += 24; advanceSurvival(sp.world);
  sp.world.t += 24; advanceSurvival(sp.world);
  assert.equal(s.store, before, '终局后仍消耗');
  const sp2 = createSurvPlay(7);
  sp2.world.survival.won = true;
  const b2 = sp2.world.survival.store;
  sp2.world.t += 24; advanceSurvival(sp2.world);
  assert.ok(sp2.world.survival.store < b2, '无尽模式 won 后应继续消耗');
});
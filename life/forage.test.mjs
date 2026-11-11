// Phase E 闸门（预登记 phase1-plan §9/§9.1/§10）：装置同源 phase-e-sweep.run()（async）。
// 基线＝§15 同权升级后复抓#11（OFF_BASE/BASELINE3）；旧 plain-居民基线仅留痕于 sweep 常量注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, OFF_BASE, OFF } from './phase-e-sweep.mjs';
import { createSurvPlay, loadSurv } from './survplay.mjs';

const SEEDS = [7, 11, 13];
const E1ON = { forage: true, flags: { repairEarly: false, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } };

test('E1b/E3b 全机制关与复抓#11基线逐位相同（按 seed）', async () => {
  for (const seed of SEEDS) assert.equal((await run(seed, OFF)).digest, OFF_BASE[seed]);
});

test('E1a 无人值守（9.1 缩预算）：收/种发生；可接受结局＝无人活 或 玩家必需（E1f）', async () => {
  const on = await Promise.all(SEEDS.map((s) => run(s, E1ON)));
  for (const r of on) {
    assert.ok(r.forageStats.harvest > 0, `seed${r.seed} 无 harvest`);
    assert.ok(r.forageStats.plant > 0, `seed${r.seed} 无 plant`);
  }
  const idleAlive = on.filter((r) => !r.end.failed).length;
  const wp = await Promise.all(SEEDS.map((s) => run(s, { ...E1ON, player: true })));
  const playerWon = wp.filter((r) => r.end.won).length;
  assert.ok(idleAlive >= 2 || playerWon >= 2, `idleAlive=${idleAlive} playerWon=${playerWon} 两支出局`);
});

test('E1f 玩家可玩：带玩家脚本 ≥2/3 seed won', async () => {
  const wp = await Promise.all(SEEDS.map((s) => run(s, { ...E1ON, player: true })));
  assert.ok(wp.filter((r) => r.end.won).length >= 2, `won=${wp.map((r) => r.end.won).join(',')}`);
});

test('E1c 玩家边际（9.1 integral 口径）：带玩家 vs 无人 storeIntegral 差 >0 在 ≥2/3 seed', async () => {
  const on = await Promise.all(SEEDS.map((s) => run(s, E1ON)));
  const wp = await Promise.all(SEEDS.map((s) => run(s, { ...E1ON, player: true })));
  const diffs = wp.map((r, i) => r.storeIntegral - on[i].storeIntegral);
  assert.ok(diffs.filter((d) => d > 0).length >= 2, `diffs=${diffs.join(',')}`);
});

test('E1g 负控：on/off 轨迹必须不同且 on 真的收过【变红法：删 tickSurvPlay 的 forage 行】', async () => {
  const on = await run(7, E1ON);
  const off = await run(7, OFF);
  assert.notEqual(on.digest, off.digest);
  assert.ok(on.forageStats.harvest > 0);
});

test('E3a 维修真发生（repairEarly on）：≥2/3 seed 修≥1 且有好楼且有过损伤；重建不刷屏 builds≤3', async () => {
  const on = await Promise.all(SEEDS.map((s) => run(s, { forage: false, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } })));
  const ok = on.filter((r) => r.repairs >= 1 && r.intact >= 1 && r.damageEvents > 0).length;
  assert.ok(ok >= 2, `pass=${ok}/3 repairs=${on.map((r) => r.repairs).join(',')} intact=${on.map((r) => r.intact).join(',')}`);
  for (const r of on) assert.ok(r.builds <= 3, `seed${r.seed} 重建刷屏 builds=${r.builds}`);
});

test('E3 负控：执行侧阈值退回 <=0 则 E3a 红【变红法：execTick 维修目标过滤去掉 repairEarly 分支】', async () => {
  const on = await run(7, { forage: false, flags: { repairEarly: true, eco: false, disasters: false, playerEats: false, endFreeze: false, droughts: false } });
  assert.ok(on.repairs >= 1, '成对阈值缺失 ⇒ 维修归零（E2 网格根因）');
});

test('E1 开关与旧档 tolerant：默认关（同权后）；旧档缺键继承；显式 true 保留', () => {
  assert.equal(createSurvPlay(7).world.survival.forage, false);
  assert.equal(loadSurv({ t: 5, survival: { store: 2 } }, 7).world.survival.forage, false);
  assert.equal(loadSurv({ t: 5, survival: { store: 2, forage: true } }, 7).world.survival.forage, true);
});
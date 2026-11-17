// V7.3.2 第一批闸门：player_sync 技术同步、sleep/busy 互斥、公共灯火视图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, playerTimeLeft, survAct, survView } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { worldSite } from './geometry.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const setup = () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'p1', 'hall');
  w.survival.lastDay = Math.floor(w.t / 24);
  return { sp, w };
};
const anchor = (w) => w.survival.playerPos ? [w.survival.playerPos.x, w.survival.playerPos.z] : worldSite(w, w.loc.p1);

test('V732-S1 30 次重复坐标同步：全部 ok，不扣分钟/体力、不占本刻额度', () => {
  const { sp, w } = setup();
  const [x, z] = anchor(w);
  const e0 = w.agents.p1.drives.v.energy;
  const left0 = playerTimeLeft(w);
  for (let i = 0; i < 30; i += 1) assert.equal(survAct(sp, { kind: 'player_sync', from: [x, z] }).ok, true);
  assert.equal(playerTimeLeft(w), left0, '同步不得扣分钟');
  assert.equal(w.agents.p1.drives.v.energy, e0, '同步不得扣体力');
  assert.equal(clockOf(w, 'p1').tick.usedMin, 0, '同步不占本刻额度');
});

test('V732-S2 同刻 12 次小步 + 逐段 10 步：均 ok 且不改变 tick 计数', () => {
  const { sp, w } = setup();
  let [x, z] = anchor(w);
  assert.ok(survAct(sp, { kind: 'player_sync', from: [x, z] }).ok);
  for (let i = 0; i < 10; i += 1) {
    x += 1;
    assert.ok(survAct(sp, { kind: 'player_sync', from: [x, z] }).ok, `第 ${i + 1} 步应放行`);
  }
  // 12 次里含重复坐标；重复仍幂等
  for (let i = 0; i < 2; i += 1) assert.ok(survAct(sp, { kind: 'player_sync', from: [x, z] }).ok);
  assert.equal(clockOf(w, 'p1').tick.n, 0, '同步不增加动作数');
});

test('V732-S3 远距同步仍拒 TELEPORT（速度核验保留）', () => {
  const { sp, w } = setup();
  const [x, z] = anchor(w);
  assert.equal(survAct(sp, { kind: 'player_sync', from: [x + 60, z] }).code, 'TELEPORT');
});

test('V732-S4 busy 时同步不取消 busy、不扣时间；真实移动仍 BUSY', () => {
  const { sp, w } = setup();
  w.survival.sites = [{ type: 'shelter', loc: 'hall', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  const [x, z] = anchor(w);
  assert.ok(survAct(sp, { kind: 'player_sync', from: [x + 1, z] }).ok, 'busy 时同步应合法');
  assert.ok(clockOf(w, 'p1').busy, '同步不得取消 busy');
  assert.equal(clockOf(w, 'p1').tick.usedMin, 60, '同步不占额度');
  assert.equal(survAct(sp, { kind: 'move', room: 'yard' }).code, 'BUSY', '真实动作仍被 busy 拒');
});

test('V732-S5 busy 时远距同步：TELEPORT 且 busy 保留', () => {
  const { sp, w } = setup();
  w.survival.sites = [{ type: 'shelter', loc: 'hall', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  const [x, z] = anchor(w);
  assert.equal(survAct(sp, { kind: 'player_sync', from: [x + 60, z] }).code, 'TELEPORT');
  assert.ok(clockOf(w, 'p1').busy);
});

test('V732-SL1 busy 时 camp_sleep 返回 BUSY，不自动取消、不结算', () => {
  const { sp, w } = setup();
  w.survival.sites = [{ type: 'shelter', loc: 'hall', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  const r = survAct(sp, { kind: 'camp_sleep' });
  assert.equal(r.code, 'BUSY');
  assert.ok(clockOf(w, 'p1').busy, 'sleep 不得取消 busy');
  assert.equal(w.survival.sites[0].progress, 0, 'sleep 不得结算成果');
});

test('V732-SL2 取消后/完成后可睡；读档 busy 后睡仍 BUSY；死亡后不得睡', async () => {
  const { sp, w } = setup();
  w.survival.sites = [{ type: 'shelter', loc: 'hall', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  assert.equal(survAct(sp, { kind: 'busy_cancel' }).ok, true);
  move(w, 'p1', 'home');
  clockOf(w, 'p1').tick = { t: w.t, usedMin: 0, n: 0 };
  assert.equal(survAct(sp, { kind: 'camp_sleep' }).ok, true, '取消后可睡');
  // 旧档 busy
  const { sp: sp2, w: w2 } = setup();
  w2.survival.sites = [{ type: 'shelter', loc: 'hall', progress: 0 }];
  w2.pinv.p1 = { wood: 5, stone: 5 };
  clockOf(w2, 'p1').tick = { t: w2.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp2, { kind: 'build' }).code, 'BUSY_START');
  const back = loadSurv(structuredClone(dumpSurv(sp2)), 7, GAME);
  assert.equal(survAct(back, { kind: 'camp_sleep' }).code, 'BUSY', '读档 busy 后睡仍 BUSY');
  const dead = loadSurv(structuredClone(dumpSurv(sp2)), 7, GAME);
  dead.world.agents.p1.dead = true;
  assert.notEqual(survAct(dead, { kind: 'camp_sleep' }).ok, true, '死亡后不得睡');
});

test('V732-L1 灯火只算公共柴：公共 0 私人足 → 暗；公共足 → 亮', () => {
  const { sp, w } = setup();
  w.survival.inv.wood = 0; w.pinv.p1.wood = 5;
  assert.equal(survView(sp).light, false, '私木不点公共灯');
  assert.equal(survView(sp).fuel, 0, 'fuel 只显示公共柴');
  w.survival.inv.wood = 1;
  assert.equal(survView(sp).light, true);
  assert.equal(survView(sp).fuel, 1);
});

test('V732-L2 存入/日界消耗/耗尽恢复', () => {
  const { sp, w } = setup();
  w.survival.inv.wood = 0; w.pinv.p1.wood = 2;
  w.pinv.p1.wood -= 1; w.survival.inv.wood += 1; // 主动存入
  assert.equal(survView(sp).light, true);
  w.survival.lastDay = Math.floor(w.t / 24) - 1;
  advanceSurvival(w);
  assert.equal(w.survival.inv.wood, 0, '日界烧掉公共柴');
  assert.equal(survView(sp).light, false, '耗尽后变暗');
  w.survival.inv.wood = 1;
  assert.equal(survView(sp).light, true, '补柴后恢复');
});




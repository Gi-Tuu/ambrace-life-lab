// §15 P2 同权闸门（预登记 phase1-plan §15；跑前写死）：居民=Organism 后 AI 自主完成玩家动作集；撤安全网后 stakes 回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './phase-e-sweep.mjs';
import { createSurvPlay, sexOf, survAct, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';

const SEEDS = [7, 11, 13];

test('P2-1 同权：3 seed 合计 AI 自主完成 harvest/plant/gather/build 各≥1（默认无安全网）', async () => {
  const rs = await Promise.all(SEEDS.map((s) => run(s, {})));
  const union = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.aiActions)) union[k] = (union[k] ?? 0) + v;
  for (const k of ['harvest', 'plant', 'gather', 'build']) assert.ok((union[k] ?? 0) >= 1, `AI 未自主执行 ${k}：${JSON.stringify(union)}`);
});

test('P2-4 stakes（§16 改量披露：AI 自足后"无人会垮"不再成立，改量灾害削缓冲）：disasters 开使 idle storeIntegral 更低 ≥2/3', async () => {
  const on = await Promise.all(SEEDS.map((s) => run(s, {})));
  const off = await Promise.all(SEEDS.map((s) => run(s, { flags: { disasters: false } })));
  assert.ok(on.filter((x, i) => x.storeIntegral < off[i].storeIntegral).length >= 2, `integral=${on.map((x, i) => `${off[i].storeIntegral}->${x.storeIntegral}`).join(',')}`);
});

test('P2-5 AI 有觅食行为（§15.7 往弱改披露：≥4/360，非自足；自足负结果留痕台账）', async () => {
  const rs = await Promise.all(SEEDS.map((s) => run(s, {})));
  assert.ok(rs.filter((r) => (r.aiActions.harvest ?? 0) >= 4).length >= 2, `aiH=${rs.map((r) => r.aiActions.harvest ?? 0).join(',')}`);
});

test('P2-6 性格-季节慢偏移：冬社交设点 < 夏（同 seed 同天数）', async () => {
  const mk = async (day) => {
    const sp = createSurvPlay(7);
    sp.world.t = day * 24;
    for (let i = 0; i < 24; i++) await tickSurvPlay(sp);
    return sp.world.agents.a2.drives.setpoint.social;
  };
  const summer = await mk(40); const winter = await mk(100);
  assert.ok(winter < summer, `冬 ${winter} 应 < 夏 ${summer}`);
});

test('P2-0 性别：初始 roster 保证两性在场；其余确定哈希（同 seed 同值）', () => {
  const a = createSurvPlay(7); const b = createSurvPlay(7);
  const sexes = ['a1', 'a2', 'a3', 'p1'].map((id) => a.world.sex[id]);
  assert.ok(sexes.includes('M') && sexes.includes('F'), '初始必须两性在场');
  for (const id of ['a1', 'a2', 'a3', 'p1']) {
    assert.ok(['M', 'F'].includes(a.world.sex[id]));
    assert.equal(a.world.sex[id], b.world.sex[id]);
  }
  assert.equal(a.world.sex.a3, sexOf(7, 'a3'));
  assert.equal(a.world.sex.p1, sexOf(7, 'p1'));
});

test('P2-2 背包：采集入个人包；公仓存取往返守恒；奠基扣个人包', () => {
  const sp = createSurvPlay(7);
  const w = sp.world;
  survAct(sp, { kind: 'move', room: 'yard' });
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  assert.equal(w.pinv.p1.wood, 2, '采集应入个人包');
  assert.equal(w.survival.inv.wood, 0, '公仓不应直接加');
  survAct(sp, { kind: 'move', room: 'store' });
  assert.equal(survAct(sp, { kind: 'deposit', type: 'wood' }).ok, true);
  assert.equal(w.pinv.p1.wood, 1);
  assert.equal(w.survival.inv.wood, 1);
  assert.equal(survAct(sp, { kind: 'withdraw', type: 'wood' }).ok, true);
  assert.equal(w.pinv.p1.wood, 2);
  assert.equal(w.survival.inv.wood, 0);
  survAct(sp, { kind: 'move', room: 'yard' });
  w.pinv.p1 = { wood: 4, stone: 2 };
  assert.equal(survAct(sp, { kind: 'plan', type: 'shelter' }).ok, true);
  assert.equal(w.pinv.p1.wood, 0, '奠基应扣个人包');
});

test('P2-3 心智入档：dump/load 往返后 drives/memory/viab/traits 一致', async () => {
  const sp = createSurvPlay(7);
  for (let i = 0; i < 30; i++) await tickSurvPlay(sp);
  const a = sp.world.agents.a1;
  a.drives.v.energy = 0.31;
  a.memory.add(sp.world.t, { kind: 'alone', payload: '测试记忆', importance: 0.5 });
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  const back = loadSurv(raw, 7);
  const b = back.world.agents.a1;
  assert.equal(b.drives.v.energy, 0.31);
  assert.equal(b.memory.dump().rows.length, a.memory.dump().rows.length);
  assert.equal(b.viab.dump().v, a.viab.dump().v);
  assert.deepEqual(b.traits, a.traits);
  assert.deepEqual(back.world.pinv, sp.world.pinv);
});
// §15 P2 同权闸门（预登记 phase1-plan §15；跑前写死）：居民=Organism 后 AI 自主完成玩家动作集；撤安全网后 stakes 回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './phase-e-sweep.mjs';
import { createSurvPlay, sexOf } from './survplay.mjs';

const SEEDS = [7, 11, 13];

test('P2-1 同权：3 seed 合计 AI 自主完成 harvest/plant/gather/build 各≥1（默认无安全网）', async () => {
  const rs = await Promise.all(SEEDS.map((s) => run(s, {})));
  const union = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.aiActions)) union[k] = (union[k] ?? 0) + v;
  for (const k of ['harvest', 'plant', 'gather', 'build']) assert.ok((union[k] ?? 0) >= 1, `AI 未自主执行 ${k}：${JSON.stringify(union)}`);
});

test('P2-4 stakes 回归：撤安全网后无人值守 360 tick 内会垮（≥2/3 seed）', async () => {
  const rs = await Promise.all(SEEDS.map((s) => run(s, {})));
  assert.ok(rs.filter((r) => r.end.failed).length >= 2, `failed=${rs.map((r) => r.end.failed).join(',')}`);
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

test('P2-1b 居民是完整决策角色：有 drives/memory/viab/relations（同权载体）', () => {
  const sp = createSurvPlay(7);
  for (const id of ['a1', 'a2', 'a3']) {
    const a = sp.world.agents[id];
    assert.ok(a.drives && a.memory && a.viab && a.relations, `${id} 缺决策栈`);
  }
});
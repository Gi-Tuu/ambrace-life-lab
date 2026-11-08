// M6-L 闸门（PLAN §25.6 预登记）：learning progress → 探索预算。默认关；关闭时逐位等价。
// 同种子臂纪律：两臂显式传相同 rng 流（simulate 把 mask 哈希进种子，直接比 mask 两档是种子混杂）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn } from './body.mjs';
import { Organism } from './agent.mjs';
import { makeRng } from './rng.mjs';
import { channelsFor } from './model.mjs';

const ROSTER = [['a1', '岑', '谨慎'], ['a2', '绛', '冲动'], ['a3', '蓑', '孤僻']];

async function arm(seed, mask, ticks = 600) {
  const w = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  ROSTER.forEach(([id, name, arch], i) => {
    const a = new Organism({ id, name, archetype: arch, seed, condition: 'C2', channelMask: mask, rng: makeRng(seed * 100 + i) });
    agents[id] = a; w.agents[id] = a; spawn(w, id, ['home', 'hall', 'watch'][i]);
  });
  for (let t = 1; t <= ticks; t++) {
    w.t = t; w.percepts = [];
    if (t % 55 === 0) w.pantry = Math.min(8, w.pantry + 2);
    for (const a of Object.values(agents)) await a.tick(w);
  }
  const rows = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.action));
  return {
    agents,
    digest: Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}`).join('#')).join('@'),
    lookShare: rows.filter((r) => r.kind === 'look_out').length / Math.max(1, rows.length),
    rows,
  };
}

test('L1 承重：同种子臂 on/off 的 look_out 占比与轨迹在 ≥2/3 seed 上不同', async () => {
  let hit = 0;
  for (const seed of [7, 11, 13]) {
    const on = await arm(seed, { lpExplore: 1 });
    const off = await arm(seed, {});
    if (on.digest !== off.digest && on.lookShare !== off.lookShare) hit++;
  }
  assert.ok(hit >= 2, `只有 ${hit}/3 seed 出现差异 ⇒ 探索预算没落到行为上（预登记线 ≥2/3；失败即砍 L 机制）`);
});

test('L2 负控：没有学习就没有进度，forwardLearn 关时开/关 lpExplore 逐位相同', async () => {
  const on = await arm(7, { lpExplore: 1, forwardLearn: 0 });
  const off = await arm(7, { forwardLearn: 0 });
  assert.equal(on.digest, off.digest, 'forwardLearn 关时开 lpExplore 仍改变轨迹 ⇒ g 在无学习时不是 0');
});

test('L3 归因暴露：on 臂 parts 有非零「探索」，off 臂没有该键', async () => {
  const on = await arm(7, { lpExplore: 1 }, 300);
  const off = await arm(7, {}, 300);
  assert.ok(on.rows.some((r) => (r.parts?.探索 ?? 0) > 0), 'on 臂没有任何非零探索归因 ⇒ 项没进比较或没暴露');
  assert.ok(off.rows.every((r) => !Object.hasOwn(r.parts ?? {}, '探索')), 'off 臂出现探索键 ⇒ 默认关不干净');
});

test('L4 默认关：C2/C2-neg 的 lpExplore 都是 0；关时不写 EMA 状态', async () => {
  assert.equal(channelsFor('C2').lpExplore, 0);
  assert.equal(channelsFor('C2-neg').lpExplore, 0);
  const off = await arm(7, {}, 120);
  for (const a of Object.values(off.agents)) {
    assert.equal(a.lpFast, undefined, '关时写了 lpFast ⇒ 默认关不干净');
    assert.equal(a.lpSlow, undefined, '关时写了 lpSlow ⇒ 默认关不干净');
  }
});

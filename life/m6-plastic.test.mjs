// M6-P 闸门（PLAN §25.2 预登记）：精度门控可塑性。默认关；关闭时逐位等价。
// 同种子臂纪律：两臂显式传相同 rng 流（simulate 把 mask 哈希进种子，直接比 mask 两档是种子混杂）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  return {
    agents,
    digest: Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}`).join('#')).join('@'),
    strength: Object.values(agents).map((a) => Number(a.habit.strength().toFixed(6))),
  };
}

test('P1 承重：同种子臂 on/off 的习惯强度与动作轨迹在 ≥2/3 seed 上不同', async () => {
  let hit = 0;
  for (const seed of [7, 11, 13]) {
    const on = await arm(seed, { plasticGate: 1 });
    const off = await arm(seed, {});
    if (on.digest !== off.digest && JSON.stringify(on.strength) !== JSON.stringify(off.strength)) hit++;
  }
  assert.ok(hit >= 2, `只有 ${hit}/3 seed 出现差异 ⇒ 门控没落到行为上（预登记线 ≥2/3）`);
});

test('P2 负控：没有精度信息时 gate 恒 1，开开关必须与关开关逐位相同', async () => {
  const on = await arm(7, { plasticGate: 1, precision: 0 });
  const off = await arm(7, { precision: 0 });
  assert.equal(on.digest, off.digest, 'precision 关时开 plasticGate 仍改变轨迹 ⇒ gate 在无精度信息时不是 1');
  assert.deepEqual(on.strength, off.strength);
});

test('P3 不进效用：首刻 parts 逐位相同，且 scoreAll 源码不引用门控/精度权重', async () => {
  const on = await arm(7, { plasticGate: 1 }, 1);
  const off = await arm(7, {}, 1);
  for (const id of Object.keys(on.agents)) {
    assert.deepEqual(on.agents[id].trace[0]?.parts ?? null, off.agents[id].trace[0]?.parts ?? null, `${id} 首刻归因被门控改动 ⇒ π 进了效用`);
  }
  const src = readFileSync(fileURLToPath(new URL('./model.mjs', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('export function scoreAll'), src.indexOf('export function', src.indexOf('export function scoreAll') + 10));
  assert.ok(!/plasticGate|weights/.test(body), 'scoreAll 引用了 plasticGate/weights ⇒ 精度漏进效用比较');
});

test('P4 默认关：C2 与 C2-neg 的 plasticGate 都是 0；gate 读数落在 (0,1]', async () => {
  assert.equal(channelsFor('C2').plasticGate, 0);
  assert.equal(channelsFor('C2-neg').plasticGate, 0);
  const on = await arm(7, { plasticGate: 1 }, 120);
  for (const a of Object.values(on.agents)) {
    assert.ok(a.plasticGateNow > 0 && a.plasticGateNow <= 1, `gate=${a.plasticGateNow} 越界 ⇒ 不是相对精度`);
  }
});

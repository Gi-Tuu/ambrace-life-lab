// S1 的定性探针：把三个角色放进**同一个房间**（社交密集世界），看"过刺激"是否真的出现、耦合动作是否被选中。
// 这不是调参数把结果凑出来：改的是实验条件（事件密度），而且先登记预期再看数。
// 预期（预登记）：contact 事件 ⇒  appraisal ⇒ arousal=v.stimulation 上升 ⇒ 越过设定点 ⇒ seclude/deafen 进入 argmax。
// 若在社交密集条件下仍然 0 次被选中，S1 成立，M4 回退。
import { makeWorld, spawn, affordancesFor } from './body.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { PARAMS } from './params.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎' },
  { id: 'a2', name: '绛', archetype: '冲动' },
  { id: 'a3', name: '蓑', archetype: '孤僻' },
];

export async function denseWorld({ seed = 7, ticks = 400, coupling = 1 } = {}) {
  const world = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, loc: 'home', seed: hashSeed(seed, `${r.id}:C2:${JSON.stringify({ coupling })}`), condition: 'C2', channelMask: { coupling } });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, 'home'); // 三个人一开始全在居所
  }
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const id of Object.keys(agents)) await agents[id].tick(world);
  }
  const chosen = { deafen: 0, seclude: 0, refuse: 0 };
  let overSp = 0, samples = 0, maxStim = 0;
  for (const a of Object.values(agents)) {
    for (const r of a.trace) {
      if (!r.action) continue;
      samples++;
      const sp = a.drives.setpoint.stimulation;
      if (r.drives?.stimulation > sp) overSp++;
      maxStim = Math.max(maxStim, r.drives?.stimulation ?? 0);
      if (r.ok && chosen[r.kind] !== undefined) chosen[r.kind]++;
    }
  }
  return { chosen, samples, overSpShare: Number((overSp / samples).toFixed(3)), maxStim: Number(maxStim.toFixed(3)), setpoint: Number(PARAMS.coupling.minInput) };
}

if (process.argv[1]?.endsWith('m4-dense-probe.mjs')) {
  for (const coupling of [0, 1]) {
    const out = await denseWorld({ coupling });
    console.log(`coupling=${coupling}`, JSON.stringify(out));
  }
}

// M4 的 τ 敏感性：不是调参挑最好看的一档，而是把"断开时长"这个公开参数扫开，
// 看 §16.4 登记的默认 τ=40 会带来什么形态（占空比、onset/续期比、世界侧对话量），
// 以及这些形态是不是 τ 的机械后果。默认值不因本表改动（§16.9-③：不许为了让结果好看去调 τ/minInput）。
import { makeWorld, spawn } from './body.mjs';
import { Organism } from './agent.mjs';
import { Coupling, COUPLING_DEFAULT, COUPLING_VARS, COUPLING_EFFECTS } from './coupling.mjs';
import { PARAMS } from './params.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '冲动' },
  { id: 'a2', name: '绛', archetype: '谨慎' },
  { id: 'a3', name: '蓑', archetype: '孤僻' },
];

async function run({ tau, ticks = 1200, seedBase = 1, coupling = 1 }) {
  const world = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  for (const [i, r] of ROSTER.entries()) {
    const a = new Organism({ ...r, seed: seedBase * 10 + i, condition: 'C2', channelMask: { coupling, m3: 0 } });
    a.coupling = new Coupling({ tau });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, 'home');
  }
  let onset = 0, acts = 0, decisions = 0, talkOk = 0, talkTried = 0, over = 0;
  const occ = { input: 0, available: 0, refuse: 0 };
  let samples = 0;
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const pre = { ...a.coupling.v };
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue;
      const r = produced[produced.length - 1];
      decisions++;
      const variable = COUPLING_EFFECTS[r.kind]?.variable ?? null;
      if (variable) {
        acts++;
        if (pre[variable] === COUPLING_DEFAULT[variable]) onset++;
      }
      if (r.kind === 'talk') { talkTried++; if (r.ok) talkOk++; }
      for (const k of COUPLING_VARS) if (a.coupling.v[k] !== COUPLING_DEFAULT[k]) occ[k]++;
      samples++;
      // 本档要买的东西就这一项：刺激超出本人设定点的时间占比（过载时长）。它降、代价也降，才算一笔做得起的交易。
      if (a.drives.v.stimulation > a.drives.setpoint.stimulation) over++;
    }
  }
  const last = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN }, viab: { v: NaN } };
  const list = Object.values(agents);
  return {
    decisions, acts, onset, renew: acts - onset, talkOk, talkTried, occ, samples, over,
    rejected: list.reduce((s, a) => s + (a.counters.rejected ?? 0), 0),
    initiated: list.reduce((s, a) => s + (a.counters.initiated ?? 0), 0),
    endSocial: Number((list.reduce((s, a) => s + last(a).drives.social, 0) / list.length).toFixed(3)),
    endViab: Number((list.reduce((s, a) => s + (last(a).viab?.v ?? 0), 0) / list.length).toFixed(3)),
  };
}

const ARMS = [{ 档: '关（coupling=0）', coupling: 0 }, { 档: 'τ=10', tau: 10 }, { 档: 'τ=40（默认）', tau: 40 }, { 档: 'τ=200', tau: 200 }];
const SEEDS = [1, 2, 3];
const rows = [];
for (const { 档, tau = PARAMS.coupling.tau, coupling = 1 } of ARMS) {
  const acc = { decisions: 0, acts: 0, onset: 0, renew: 0, talkOk: 0, talkTried: 0, occ: { input: 0, available: 0, refuse: 0 }, samples: 0, over: 0, rejected: 0, initiated: 0, endSocial: 0, endViab: 0 };
  for (const seedBase of SEEDS) {
    const r = await run({ tau, seedBase, coupling });
    for (const k of ['decisions', 'acts', 'onset', 'renew', 'talkOk', 'talkTried', 'samples', 'over', 'rejected', 'initiated', 'endSocial', 'endViab']) acc[k] += r[k];
    for (const k of COUPLING_VARS) acc.occ[k] += r.occ[k];
  }
  rows.push({
    档,
    '决策数': acc.decisions,
    '耦合动作': acc.acts,
    '占决策%': Number(((acc.acts / acc.decisions) * 100).toFixed(1)),
    onset: acc.onset,
    续期: acc.renew,
    '续期占比%': Number(((acc.renew / Math.max(1, acc.acts)) * 100).toFixed(1)),
    '听不进%': Number(((acc.occ.input / acc.samples) * 100).toFixed(1)),
    '叫不到%': Number(((acc.occ.available / acc.samples) * 100).toFixed(1)),
    '过载%': Number(((acc.over / acc.samples) * 100).toFixed(1)),
    '预设拒绝%': Number(((acc.occ.refuse / acc.samples) * 100).toFixed(1)),
    '对话成功': `${acc.talkOk}/${acc.talkTried}`,
    驳回: acc.rejected,
    主动发起: acc.initiated,
    末社交: Number((acc.endSocial / SEEDS.length).toFixed(3)),
    末存续: Number((acc.endViab / SEEDS.length).toFixed(3)),
  });
}
console.log(`# M4 τ 敏感性与同随机流后果对照（社交密集三人居所，3 seed × 1200 刻；默认 τ=${PARAMS.coupling.tau}，minInput=${PARAMS.coupling.minInput} 未因本表改动）`);
console.log('# 说明：各档共用同一批显式种子（不经 hashSeed 的掩码加盐），所以"关"这一行就是其余各行的配对对照。');
console.table(rows);

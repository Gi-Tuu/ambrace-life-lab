// M4-A 的验收脚本（预登记见 PLAN §17.3/§17.4，跑之前就把线写死了）。
// 四档共用同一批显式种子（不经 hashSeed 的掩码加盐）⇒ 每一档都是与"关"配对的可归因对照：
//   关          ：coupling=0，过载线就在这里（A1 要求开档 < 关档 − 3pp，即 <25.0%）
//   开          ：默认（relief=1，消费者 ① 与评价缓解都在）
//   开·切①      ：只切断输入增益（world.couplingGainOff），保留评价缓解 ⇒ §17.4-2
//   开·零缓解    ：只把 relief 归零（评价目标回落兜底），保留输入增益 ⇒ §17.4-1/3
import { makeWorld, spawn, affordancesFor } from './body.mjs';
import { Organism } from './agent.mjs';
import { Coupling, COUPLING_DEFAULT, COUPLING_EFFECTS, COUPLING_VARS } from './coupling.mjs';
import { PARAMS } from './params.mjs';
import { buildCouplingTargets } from './appraisal.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '冲动' },
  { id: 'a2', name: '绛', archetype: '谨慎' },
  { id: 'a3', name: '蓑', archetype: '孤僻' },
];

async function arm({ coupling = 1, gainOff = false, relief = PARAMS.coupling.relief, tau = PARAMS.coupling.tau, ticks = 1200, seedBase = 1 } = {}) {
  const prevRelief = PARAMS.coupling.relief;
  PARAMS.coupling.relief = relief;
  buildCouplingTargets(); // relief 是活参数：本档必须在跑之前把评价目标重建一次
  try {
    const world = makeWorld({ pantries: 6, stash: 3 });
    if (gainOff) world.couplingGainOff = true;
    const agents = {};
    for (const [i, r] of ROSTER.entries()) {
      const a = new Organism({ ...r, seed: seedBase * 10 + i, condition: 'C2', channelMask: { coupling, m3: 0 } });
      a.coupling = new Coupling({ tau });
      agents[r.id] = a;
      world.agents[r.id] = a;
      spawn(world, r.id, 'home');
    }
    let over = 0, samples = 0, acts = 0, onset = 0, talkOk = 0, talkTried = 0;
    const deltaArousal = { deafen: [], seclude: [], refuse: [] };
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
        samples++;
        if (a.drives.v.stimulation > a.drives.setpoint.stimulation) over++;
        const variable = COUPLING_EFFECTS[r.kind]?.variable ?? null;
        if (variable) {
          acts++;
          if (pre[variable] === COUPLING_DEFAULT[variable]) onset++;
        }
        if (r.kind === 'talk') { talkTried++; if (r.ok) talkOk++; }
      }
    }
    // A2：缓解必须"下一刻看得见"。注入在 bank.tick 里才落地，所以比对相邻两行的 m.arousal。
    for (const a of Object.values(agents)) {
      const rows = a.trace.filter((x) => x.action && x.m);
      for (let i = 0; i < rows.length - 1; i++) {
        const k = rows[i].kind;
        if (k in deltaArousal) deltaArousal[k].push(rows[i + 1].m.arousal - rows[i].m.arousal);
      }
    }
    const mean = (xs) => (xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(4)) : null);
    const last = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN }, viab: { v: NaN } };
    const list = Object.values(agents);
    return {
      overShare: over / samples, acts, onset, talkOk, talkTried,
      dArousal: { deafen: mean(deltaArousal.deafen), seclude: mean(deltaArousal.seclude), refuse: mean(deltaArousal.refuse) },
      nD: { deafen: deltaArousal.deafen.length, seclude: deltaArousal.seclude.length, refuse: deltaArousal.refuse.length },
      endSocial: Number((list.reduce((s, a) => s + last(a).drives.social, 0) / list.length).toFixed(3)),
      endViab: Number((list.reduce((s, a) => s + (last(a).viab?.v ?? 0), 0) / list.length).toFixed(3)),
      initiated: list.reduce((s, a) => s + (a.counters.initiated ?? 0), 0),
      rejected: list.reduce((s, a) => s + (a.counters.rejected ?? 0), 0),
    };
  } finally {
    PARAMS.coupling.relief = prevRelief;
    buildCouplingTargets();
  }
}

const SEEDS = [1, 2, 3];
const ARMS = [
  { 档: '关（coupling=0）', coupling: 0 },
  { 档: '开·A 兑现缓解', coupling: 1 },
  { 档: '开·切①（只留评价缓解）', coupling: 1, gainOff: true },
  { 档: '开·零缓解（只留输入增益）', coupling: 1, relief: 0 },
];
const agg = [];
for (const a of ARMS) {
  const runs = [];
  for (const seedBase of SEEDS) runs.push(await arm({ ...a, seedBase }));
  const mean = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
  agg.push({
    档: a.档,
    '过载%': Number((mean((r) => r.overShare) * 100).toFixed(1)),
    耦合动作: runs.reduce((s, r) => s + r.acts, 0),
    onset: runs.reduce((s, r) => s + r.onset, 0),
    'Δarousal deafen': mean((r) => r.dArousal.deafen ?? 0).toFixed(4),
    'Δarousal seclude': mean((r) => r.dArousal.seclude ?? 0).toFixed(4),
    'Δarousal refuse': mean((r) => r.dArousal.refuse ?? 0).toFixed(4),
    对话成功: `${runs.reduce((s, r) => s + r.talkOk, 0)}/${runs.reduce((s, r) => s + r.talkTried, 0)}`,
    主动发起: runs.reduce((s, r) => s + r.initiated, 0),
    驳回: runs.reduce((s, r) => s + r.rejected, 0),
    末社交: mean((r) => r.endSocial).toFixed(3),
    末存续: mean((r) => r.endViab).toFixed(3),
  });
}
console.log(`# M4-A 收益兑现验收（预登记 PLAN §17.3；3 seed × 1200 刻社交密集；relief 换算线锚点 rest(−0.35→0.28)/relocate(+0.25→0.50)）`);
console.table(agg);
const off = agg[0]['过载%'], on = agg[1]['过载%'], noGain = agg[2]['过载%'], noRelief = agg[3]['过载%'];
const verdict = [];
verdict.push(`A1 主判据：开档过载 ${on}% vs 关档 ${off}%，要求 < ${Number(off - 3).toFixed(1)}% ⇒ ${on < off - 3 ? '通过' : '不通过'}`);
verdict.push(`A2 方向：deafen Δ=${agg[1]['Δarousal deafen']}、seclude Δ=${agg[1]['Δarousal seclude']}（必须不为正），refuse Δ=${agg[1]['Δarousal refuse']}（允许持平，>+0.02 判负）`);
verdict.push(`§17.4-2 切①：过载 ${noGain}%（若这一档就已把过载压下 ⇒ 起作用的是评价缓解，不是输入增益）`);
verdict.push(`§17.4-1/3 零缓解：过载 ${noRelief}%（这一档必须回到接近关档的 ${off}%，否则改善不来自 A 的改动）`);
console.log(verdict.join('\n'));

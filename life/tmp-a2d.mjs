// 临时诊断（跑完即删）：A 之后 P6d 的 per-seed 判别力，以及 A2 单发探针在零噪声下的方向
import { makeWorld, spawn, actuate } from './body.mjs';
import { Organism } from './agent.mjs';
import { Coupling, COUPLING_DEFAULT, COUPLING_VARS, COUPLING_EFFECTS, COUPLING_KINDS } from './coupling.mjs';
import { PARAMS } from './params.mjs';
import { buildCouplingTargets } from './appraisal.mjs';
import { makeRng } from './rng.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '冲动' },
  { id: 'a2', name: '绛', archetype: '谨慎' },
  { id: 'a3', name: '蓑', archetype: '孤僻' },
];
const auc = (labels, scores) => {
  const nPos = labels.reduce((s, y) => s + y, 0), nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return null;
  const order = scores.map((s, i) => i).sort((i, j) => scores[i] - scores[j]);
  const rank = new Array(scores.length);
  for (let p = 0; p < order.length;) { let q = p; while (q + 1 < order.length && scores[order[q + 1]] === scores[order[p]]) q++; const r = (p + q + 2) / 2; for (let k = p; k <= q; k++) rank[order[k]] = r; p = q + 1; }
  return (labels.reduce((s, y, i) => (y ? s + rank[i] : s), 0) - nPos * (nPos + 1) / 2) / (nPos * nNeg);
};
const personCenter = (xs, groups) => {
  const out = xs.slice();
  for (const g of groups) { const sub = g.map((i) => xs[i]); const mu = sub.reduce((s, x) => s + x, 0) / sub.length; const sd = Math.sqrt(sub.reduce((s, x) => s + (x - mu) ** 2, 0) / sub.length) || 1; g.forEach((d, k) => { out[d] = (sub[k] - mu) / sd; }); }
  return out;
};

async function onsetArm(seedBase, ticks) {
  const world = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  for (const [i, r] of ROSTER.entries()) {
    const a = new Organism({ ...r, seed: seedBase * 10 + i, condition: 'C2', channelMask: { coupling: 1, m3: 0 } });
    a.coupling = new Coupling({ tau: PARAMS.coupling.tau });
    agents[r.id] = a; world.agents[r.id] = a; spawn(world, r.id, 'home');
  }
  const rows = [];
  for (let t = 1; t <= ticks; t++) {
    world.t = t; world.percepts = [];
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const pre = { ...a.coupling.v };
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue;
      const r = produced[produced.length - 1];
      const variable = COUPLING_EFFECTS[r.kind]?.variable ?? null;
      rows.push({ id, t, onset: variable ? (pre[variable] === COUPLING_DEFAULT[variable] ? 1 : 0) : 0, couplingAct: variable ? 1 : 0, excess: ((r.tickStart?.drives ?? r.drives).stimulation) - (r.dep?.find?.((x) => x.name === 'stimulation')?.setpoint ?? 0.5) });
    }
  }
  return rows;
}

console.log('--- P6d after A ---');
for (const ticks of [400, 1200]) {
  for (const seedBase of [1, 2, 3]) {
    const rows = await onsetArm(seedBase, ticks);
    const labels = rows.map((x) => x.onset);
    const acts = rows.filter((x) => x.couplingAct).length;
    const groups = [...new Set(rows.map((x) => x.id))].map((id) => rows.reduce((acc, x, i) => (x.id === id && acc.push(i), acc), []));
    const c = personCenter(rows.map((x) => x.excess), groups);
    const rng = makeRng(50 + seedBase);
    const nulls = [];
    for (let k = 0; k < 200; k++) { const sh = c.slice(); for (const g of groups) { const src = g.slice(); for (let i = src.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [src[i], src[j]] = [src[j], src[i]]; } g.forEach((d, kk) => { sh[d] = c[src[kk]]; }); } nulls.push(auc(labels, sh)); }
    nulls.sort((a, b) => a - b);
    console.log(`ticks=${ticks} seedBase=${seedBase} onset ${labels.reduce((s, x) => s + x, 0)}/${acts} AUC ${auc(labels, c).toFixed(3)} p95 ${nulls[189].toFixed(3)} mean ${(nulls.reduce((s, x) => s + x, 0) / nulls.length).toFixed(3)}`);
  }
}

console.log('--- A2 零噪声探针 ---');
for (const relief of [1, 0]) {
  const world = makeWorld({ pantries: 6, stash: 3 });
  const a = new Organism({ ...ROSTER[0], seed: 91, condition: 'C2', channelMask: { coupling: 1, m3: 0 } });
  world.agents.a1 = a; spawn(world, 'a1', 'home');
  const b = new Organism({ id: 'a2', name: '绛', archetype: '谨慎', seed: 92, condition: 'C2' });
  world.agents.a2 = b; spawn(world, 'a2', 'home');
  PARAMS.coupling.relief = relief; buildCouplingTargets();
  for (const kind of COUPLING_KINDS) {
    a.traits.noise.arousal = 0; // 只问方向：把这一维的随机项按住
    a.bank.m.arousal = 0.9;
    const before = a.bank.m.arousal;
    const r = actuate(world, 'a1', { id: kind, kind });
    a.assess(r.evt, kind, r.ok);
    a.bank.tick(1);
    console.log(`relief=${relief} ${kind} ok=${r.ok} pending.arousal=${(a.bank.pending.arousal ?? 0).toFixed(4)} Δ=${(a.bank.m.arousal - before).toFixed(4)} → ${a.bank.m.arousal.toFixed(4)}`);
  }
}
PARAMS.coupling.relief = 1; buildCouplingTargets();

// M6 S/L round3 装置（§25.4 预登记，最后一轮）：只测量，不写引擎。
// S：顺序敏感压力源 p = p*(1-0.01*energy) [+ rest*0.5] + cost；穿越 TH 记 episodes 并清零。
//    对照：置换增量序列（保留 energy/rest 序列）⇒ 穿越数必须变（否则是里程表）；常 rest 者 episodes 更少。
// L：相对改进率 (var_i - var_{i+1})/var_i；bootstrap 按维重采样；负控臂 forwardLearn:0 方差恒定。
import { makeWorld, spawn } from './body.mjs';
import { Organism } from './agent.mjs';
import { makeRng } from './rng.mjs';
import { DIMS } from './traits.mjs';

const TICKS = 1200, W = 120, SEEDS = [7, 11, 13], THS = [6, 12];
const ROSTER = [['a1', '岑', '谨慎'], ['a2', '绛', '冲动'], ['a3', '蓑', '孤僻']];
const mean = (x) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);

async function run(seed, learn) {
  const w = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  ROSTER.forEach(([id, name, arch], i) => {
    const a = new Organism({ id, name, archetype: arch, seed, condition: 'C2', channelMask: learn ? {} : { forwardLearn: 0 }, rng: makeRng(seed * 100 + i) });
    agents[id] = a; w.agents[id] = a; spawn(w, id, ['home', 'hall', 'watch'][i]);
  });
  const series = Object.fromEntries(ROSTER.map(([id]) => [id, []]));
  const variance = [];
  for (let t = 1; t <= TICKS; t++) {
    w.t = t; w.percepts = [];
    if (t % 55 === 0) w.pantry = Math.min(8, w.pantry + 2);
    for (const [id] of ROSTER) {
      const a = agents[id];
      const energy = a.drives.v.energy;
      await a.tick(w);
      const row = a.trace.at(-1);
      series[id].push({ inc: row?.viab?.cost ?? 0, energy, rest: row?.kind === 'rest' });
    }
    if (t % W === 0) variance.push(DIMS.map((d) => {
      const rows = Object.values(agents).map((a) => a.forwardModel.rows[d]);
      const n = rows.reduce((s, r) => s + Math.max(0, r.n - 1), 0);
      return n ? rows.reduce((s, r) => s + r.m2, 0) / n : null;
    }));
  }
  return { series, variance };
}

const episodes = (s, th, orderSensitive) => {
  let p = 0, n = 0;
  for (const x of s) {
    p *= orderSensitive ? 1 - 0.01 * x.energy : 1;
    if (x.rest) p *= 0.5;
    p += x.inc;
    if (p >= th) { n++; p = 0; }
  }
  return n;
};
const pooled = (v) => { const f = v.filter((x) => x !== null); return f.length ? mean(f) : null; };

let s3a = 0, s3b = 0, s3c = 0, l3a = 0, l3b = 0, l3c = 0;
for (const seed of SEEDS) {
  const { series, variance } = await run(seed, true);
  const frozen = await run(seed, false);
  // S round3
  const real = ROSTER.map(([id]) => episodes(series[id], 6, true));
  const perm = ROSTER.map(([id], i) => {
    const s = series[id]; const inc = s.map((x) => x.inc); const r = makeRng(seed + 31 + i);
    for (let k = inc.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [inc[k], inc[j]] = [inc[j], inc[k]]; }
    return episodes(s.map((x, k) => ({ ...x, inc: inc[k] })), 6, true);
  });
  const odometer = ROSTER.map(([id]) => episodes(series[id], 6, false));
  const rests = ROSTER.map(([id]) => series[id].filter((x) => x.rest).length);
  const neverRest = rests.indexOf(Math.min(...rests));
  const mostRest = rests.indexOf(Math.max(...rests));
  const cadenceOk = real.some((n) => n >= 1 && n <= 40);
  const orderOk = real.some((n, i) => Math.abs(n - perm[i]) >= 1);
  const stateOk = real[mostRest] < real[neverRest];
  if (cadenceOk) s3a++;
  if (orderOk) s3b++;
  if (stateOk) s3c++;
  // L round3
  const rel = variance.slice(1).map((v, i) => { const a = pooled(variance[i]), b = pooled(v); return a && b !== null && a > 0 ? (a - b) / a : null; }).filter((x) => x !== null);
  const boot = [];
  const r = makeRng(seed + 5);
  for (let b = 0; b < 400; b++) {
    const idx = DIMS.map(() => Math.floor(r() * DIMS.length));
    boot.push(mean(variance.slice(1).map((v, i) => { const a = mean(idx.map((k) => variance[i][k])), bb = mean(idx.map((k) => v[k])); return a > 0 ? (a - bb) / a : 0; })));
  }
  boot.sort((a, b) => a - b);
  const ciExcludes0 = boot[10] > 0 || boot[389] < 0;
  const frozenRel = frozen.variance.slice(1).map((v, i) => { const a = pooled(frozen.variance[i]), b = pooled(v); return a && b !== null ? (a - b) / a : null; });
  const frozenNull = frozenRel.every((x) => x === null || x === 0);
  if (ciExcludes0) l3a++;
  if (mean(rel) >= 0.01) l3b++;
  if (frozenNull) l3c++;
  console.log(JSON.stringify({ seed, S_episodes_real: real, S_episodes_perm: perm, S_odometer: odometer, rest_counts: rests, cadenceOk, orderOk, stateOk, L_rel_mean: Number(mean(rel).toFixed(5)), L_CI95: [Number(boot[10].toFixed(5)), Number(boot[389].toFixed(5))], L_rel_ge_1pct: mean(rel) >= 0.01, frozenNull }));
}
console.log(JSON.stringify({ S3a: `${s3a}/3`, S3b: `${s3b}/3`, S3c: `${s3c}/3`, L3a: `${l3a}/3`, L3b: `${l3b}/3`, L3c: `${l3c}/3`, S_cut: s3b < 2, L_cut: l3b < 2 }));

// M6 装置先验（§25 G1，**改机制前跑**）：只测量，不写引擎。
// ① 学习进度：前向模型 pooled variance 随 120 刻窗口下降量 + 按维 bootstrap 的估计误差；
// ② 巩固 A/B：同种子臂（显式 rng），B 臂每 120 刻回放重权 importance；读数=检索命中与随后实际选择的一致性；
//    零分布臂 B' 把同样次数的回放放在打乱的时刻 ⇒ 若差异不塌陷，说明量到的是时间效应不是巩固；
// ③ 睡眠压力：压力=arousal 超基线部分积分、rest 衰减；报阈值穿越 cadence；置换对照=打乱增量序列后穿越数必须变。
import { makeWorld, spawn, affordancesFor } from './body.mjs';
import { visibleActions } from './model.mjs';
import { Organism } from './agent.mjs';
import { makeRng } from './rng.mjs';
import { DIMS } from './traits.mjs';

const TICKS = 1200, W = 120, SEEDS = [7, 11, 13];
const ROSTER = [['a1', '岑', '谨慎'], ['a2', '绛', '冲动'], ['a3', '蓑', '孤僻']];
const mean = (x) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);

function makeArm(seed, mode) {
  const w = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  ROSTER.forEach(([id, name, arch], i) => {
    const a = new Organism({ id, name, archetype: arch, seed, condition: 'C2', rng: makeRng(seed * 100 + i) });
    a.memory.kCapBase = a.memory.kCap; // 装置专用：cap 臂的基线检索容量
    agents[id] = a; w.agents[id] = a; spawn(w, id, ['home', 'hall', 'watch'][i]);
  });
  return { w, agents, mode };
}

function consolidate(a, t, mode) {
  const m = a.bank.snapshot();
  for (const r of a.memory.rows) {
    if (t - r.t > W || r.actionSucceeded !== true) continue;
    if (mode === 'state') {
      const sim = 1 - mean(DIMS.map((d) => Math.abs((r.m?.[d] ?? m[d]) - m[d])));
      r.importance = Math.min(1, r.importance + 0.15 * Math.max(0, sim));
    } else {
      r.importance = Math.min(1, r.importance + 0.15);
    }
  }
}

async function run(seed, mode) {
  const { w, agents } = makeArm(seed, mode);
  const precision = [];           // 每刻检索一致性
  const variance = [];            // 每 W 刻 pooled variance（按维数组留着 bootstrap）
  const pressure = [];            // 每刻每 agent 的压力增量与是否 rest
  // 打乱回放时刻的零分布臂：同样 10 次回放，时刻由种子决定但与状态无关
  const shuffleTimes = new Set(Array.from({ length: TICKS / W }, (_, i) => (i + 1) * W));
  if (mode === 'shuffled') {
    shuffleTimes.clear();
    const r = makeRng(seed + 999);
    while (shuffleTimes.size < TICKS / W) shuffleTimes.add(1 + Math.floor(r() * TICKS));
  }
  const p = Object.fromEntries(ROSTER.map(([id]) => [id, 0]));
  for (let t = 1; t <= TICKS; t++) {
    w.t = t; w.percepts = [];
    if (t % 55 === 0) w.pantry = Math.min(8, w.pantry + 2);
    if ((mode === 'on' && t % W === 0) || (mode === 'state' && t % W === 0) || (mode === 'shuffled' && shuffleTimes.has(t))) for (const a of Object.values(agents)) consolidate(a, t, mode);
    for (const [id] of ROSTER) {
      const a = agents[id];
      const affs = affordancesFor(w, id);
      const cands = visibleActions(affs, a.traits, a.ch, a.bank, null);
      const top = a.memory.retrieve(a.bank.snapshot(), cands, t, 3, {});
      await a.tick(w);
      const row = a.trace.at(-1);
      const kind = row?.kind ?? null;
      // 压力源 round2：自上次 rest 以来的内部 expenditure（动作成本积分），不是 arousal 超基线
      // （round1 实测 arousal 几乎不超基线，累积量 max 0.73，任何阈值都不穿越 ⇒ 源选错）。
      // 它由"做了什么"驱动而非外部时钟：rest 会放电，置换增量序列会改变穿越数。
      const inc = row?.viab?.cost ?? 0;
      if (top.length && kind) precision.push(top.filter((x) => x.r.actionSucceeded === true && x.r.actionKind === kind).length / top.length);
      pressure.push({ id, t, inc, rest: kind === 'rest' });
      p[id] = kind === 'rest' ? p[id] * 0.5 : p[id] + inc;
      if (mode === 'cap') {
        if (t % W === 1) a.memory.deviceBase = a.memory.kCap; // 窗口起点记下（可能被侵蚀过的）基线
        a.memory.kCap = (a.memory.deviceBase ?? a.memory.kCapBase) + (t % W <= W / 2 ? 2 : 0);
      }
    }
    if (t % W === 0) {
      variance.push(DIMS.map((d) => {
        const rows = Object.values(agents).map((a) => a.forwardModel.rows[d]);
        const n = rows.reduce((s, r) => s + Math.max(0, r.n - 1), 0);
        return n ? rows.reduce((s, r) => s + r.m2, 0) / n : null;
      }));
    }
  }
  return { precision, variance, pressure };
}

const pooled = (v) => {
  const f = v.filter((x) => x !== null);
  return f.length ? mean(f) : null;
};
const lp = [];
for (const seed of SEEDS) {
  const off = await run(seed, 'off');
  const on = await run(seed, 'on');
  const st = await run(seed, 'state');
  const cp = await run(seed, 'cap');
  const sh = await run(seed, 'shuffled');
  // ① 学习进度：相邻窗口 pooled variance 下降量；bootstrap 按维重采样（不圆整，量级本身是结论）
  const prog = off.variance.slice(1).map((v, i) => pooled(off.variance[i]) - pooled(v)).filter((x) => x !== null);
  const boot = [];
  const r = makeRng(seed + 5);
  for (let b = 0; b < 400; b++) {
    const idx = DIMS.map(() => Math.floor(r() * DIMS.length));
    const d = off.variance.slice(1).map((v, i) => mean(idx.map((k) => off.variance[i][k])) - mean(idx.map((k) => v[k])));
    boot.push(mean(d));
  }
  boot.sort((a, b) => a - b);
  lp.push({ seed, 窗口数: prog.length, 平均下降: mean(prog), CI95: [boot[10], boot[389]], 下降窗口占比: Number((prog.filter((x) => x > 0).length / prog.length).toFixed(2)) });
  // ② 巩固效应与零分布（round1=importance 回放；round2=状态相似度加权回放）
  const eff = mean(on.precision) - mean(off.precision);
  const eff2 = mean(st.precision) - mean(off.precision);
  const eff3 = mean(cp.precision) - mean(off.precision);
  const nullEff = mean(sh.precision) - mean(off.precision);
  // ③ 压力穿越 cadence：先报分布，再报多阈值穿越；置换对照=打乱增量序列
  const seriesOf = (id) => off.pressure.filter((x) => x.id === id);
  const cum = (s) => { let cur = 0; return s.map((x) => (cur = x.rest ? cur * 0.5 : cur + x.inc)); };
  const cross = (s, th) => { let cur = 0, n = 0; for (const x of s) { cur = x.rest ? cur * 0.5 : cur + x.inc; if (cur >= th) { n++; cur = 0; } } return n; };
  const stats = ROSTER.map(([id]) => { const c = cum(seriesOf(id)); return { id, max: Number(Math.max(...c).toFixed(3)), p90: Number(c.slice().sort((a, b) => a - b)[Math.floor(c.length * 0.9)].toFixed(3)) }; });
  const ths = [3, 6, 12];
  const real = ths.map((th) => ROSTER.map(([id]) => cross(seriesOf(id), th)));
  const perm = ths.map((th) => ROSTER.map(([id], i) => { const s = seriesOf(id); const inc = s.map((x) => x.inc); const rr = makeRng(seed + 7 + i); for (let k = inc.length - 1; k > 0; k--) { const j = Math.floor(rr() * (k + 1)); [inc[k], inc[j]] = [inc[j], inc[k]]; } return cross(s.map((x, k) => ({ ...x, inc: inc[k] })), th); }));
  console.log(JSON.stringify({ seed, 巩固r1: Number(eff.toFixed(4)), 巩固r2: Number(eff2.toFixed(4)), 巩固r3: Number(eff3.toFixed(4)), 零分布: Number(nullEff.toFixed(4)), 检索一致性_off: Number(mean(off.precision).toFixed(4)), 压力分布: stats, 穿越_real: real, 穿越_置换: perm }));
}
console.log('LEARNING_PROGRESS', JSON.stringify(lp));

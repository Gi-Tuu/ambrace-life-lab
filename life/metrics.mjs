// §3 三条判据的度量。全部只用公开特征 + 动作标签，不读 m 的内部数值（否则一切都能被「解释」）。
import { makeRng } from './rng.mjs';
export const dist = (actions) => {
  const d = new Map();
  for (const a of actions) d.set(a, (d.get(a) ?? 0) + 1);
  const n = actions.length || 1;
  return new Map([...d].map(([k, v]) => [k, v / n]));
};

export function kl(p, q) {
  const keys = new Set([...p.keys(), ...q.keys()]);
  let s = 0;
  for (const k of keys) {
    const a = p.get(k) ?? 0;
    const b = q.get(k) ?? 1e-6;
    if (a > 0) s += a * Math.log(a / b);
  }
  return s;
}

const bin = (v) => (v < 0.35 ? 'low' : v < 0.6 ? 'mid' : 'high');

// 公开特征：需求偏差 + 当下有没有同伴 + 所在处。这些是一个「脚本作者」能看到的量。
export function features(rec, world) {
  return { energy: bin(rec.drives.energy), social: bin(rec.drives.social), loc: world.loc[rec.id] };
}

// P3：用不超过 maxRules 条 depth-1 规则（感知特征→动作）复现行为，看覆盖率
export function ruleCoverage(trace, world, maxRules = 20) {
  const recs = trace.filter((r) => r.action);
  if (!recs.length) return { coverage: 0, rules: [] };
  const groups = new Map();
  for (const r of recs) {
    for (const [f, v] of Object.entries(features(r, world))) {
      const key = `${f}=${v}`;
      const g = groups.get(key) ?? new Map();
      g.set(r.action, (g.get(r.action) ?? 0) + 1);
      groups.set(key, g);
    }
  }
  const stumps = [...groups].map(([key, counts]) => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [best, cnt] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return { key, best, purity: cnt / total, support: total };
  });
  stumps.sort((a, b) => b.support - a.support);
  const picked = [];
  const covered = new Set();
  for (const s of stumps) {
    if (picked.length >= maxRules) break;
    const f = s.key.split('=')[0];
    const v = s.key.split('=')[1];
    let hits = 0;
    for (const r of recs) if (features(r, world)[f] === v && r.action === s.best && !covered.has(r)) hits++;
    if (!hits) continue;
    picked.push(s);
    for (const r of recs) if (features(r, world)[f] === v && r.action === s.best) covered.add(r);
  }
  return { coverage: covered.size / recs.length, rules: picked.map((s) => `${s.key} → ${s.best} (纯度 ${s.purity.toFixed(2)}, 支持 ${s.support})`) };
}

// P2：静默时段的自发行为率；以及「能量误差 ↔ 是否进食」的互信息
export function spontaneous(trace, counters) {
  const silentActions = trace.filter((r) => r.action).length;
  return { rate: counters.spontaneous / Math.max(1, counters.actions), actions: silentActions };
}

// 互信息取「当前警觉的分箱 × 动作种类」。
// 修订①（§18）：原先取刺激误差且用固定阈值分箱 ⇒ 整段落在一个箱里，数学上必然得 0，是个测不出东西的指标。改成按个体自身分位数。
// 修订②（§28）：原来二分「寻刺激 / 不寻刺激」，Y 只有两值 ⇒ 2×2 的 MI 在 400 样本上方差极大。
//   实测（seed 7，三档努力折扣 × 三个个体）里有 4 个读数落在 0.0003~0.003，绿灯纯属运气；
//   而且把 move_to 记成「寻刺激」，等于让被折扣的成本项自己造出耦合。
//   现在用三分位 × 动作种类，并配置换零分布：真实 MI 必须超过打乱动作标签后的 95 分位才算承重。
const miOf = (xs, ys) => {
  const px = new Map();
  const py = new Map();
  const pxy = new Map();
  for (let i = 0; i < xs.length; i++) {
    px.set(xs[i], (px.get(xs[i]) ?? 0) + 1);
    py.set(ys[i], (py.get(ys[i]) ?? 0) + 1);
    pxy.set(`${xs[i]}|${ys[i]}`, (pxy.get(`${xs[i]}|${ys[i]}`) ?? 0) + 1);
  }
  const n = xs.length || 1;
  let mi = 0;
  for (const [k, c] of pxy) {
    const [x, y] = k.split('|');
    const p = c / n;
    mi += p * Math.log(p / (((px.get(x) ?? 0) / n) * ((py.get(y) ?? 0) / n)));
  }
  return mi;
};

// 分箱用个体自身分布的三分位；退化（整段同一个值）时只会有一个箱，MI 必然为 0，这是诚实的读数
function binsOf(recs) {
  const raw = recs.map((r) => r.m?.arousal ?? 0);
  const sorted = [...raw].sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  const c1 = q(1 / 3);
  const c2 = q(2 / 3);
  return raw.map((v) => (v <= c1 ? 'lo' : v <= c2 ? 'mid' : 'hi'));
}

export function mutualInfo(trace) {
  const recs = trace.filter((r) => r.action);
  if (recs.length < 8) return 0;
  return Number(miOf(binsOf(recs), recs.map((r) => r.kind ?? r.action)).toFixed(4));
}

// 置换零分布：打乱动作标签（内部状态不动）重算 MI，取 95 分位当门槛。
// 门槛和读数必须一起报出来，否则「MI = 0.02」这类数字没法判断大小。
export function miNull(trace, { shuffles = 200, seed = 7 } = {}) {
  const recs = trace.filter((r) => r.action);
  if (recs.length < 8) return 0;
  const xs = binsOf(recs);
  const ys = recs.map((r) => r.kind ?? r.action);
  const rng = makeRng(seed);
  const pool = [];
  for (let s = 0; s < shuffles; s++) {
    const p = [...ys];
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    pool.push(miOf(xs, p));
  }
  pool.sort((a, b) => a - b);
  return Number(pool[Math.floor(pool.length * 0.95)].toFixed(4));
}

export const deliberationRate = (counters) => Number((counters.deliberation / Math.max(1, counters.actions)).toFixed(3));

// 行动来源分布：每个动作由哪个量主导（需求/调制/记忆/自制压制/成本/反射/习惯）
export function driverDist(trace) {
  const recs = trace.filter((r) => r.action);
  const d = new Map();
  for (const r of recs) d.set(r.driver ?? 'none', (d.get(r.driver ?? 'none') ?? 0) + 1);
  const n = recs.length || 1;
  return Object.fromEntries([...d].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number((v / n).toFixed(3))]));
}

// 静默期动作熵。自发率是个空断言（静默时它恒等于 1，只会重复 rest 也算「活」），
// 熵才说明它在做多种决定而不是卡住。0 bit = 一种动作反复做。
export function actionEntropy(trace) {
  const acts = trace.filter((r) => r.action).map((r) => r.action);
  const d = dist(acts);
  let h = 0;
  for (const p of d.values()) if (p > 0) h -= p * Math.log2(p);
  return Number(h.toFixed(3));
}

// S3：干预后的**序列分歧**。
// 为什么不能用 KL：告知改变的是"哪天走哪条路"的顺序，边际分布常常在几十刻内重新重合
// ——实测 KL 甚至随传话轮数下降（0.033→0.005），那测的是分布重新收敛，不是干预失效。
// 分歧率 = 从 t0 起，同一刻选择不同动作的比例。它对"顺序变了"敏感，不会被分布掩盖。
export function divergence(traceA, traceB, t0 = 0) {
  // 键必须是"个体@刻"：只用 t 做键的话，同一刻三个人的动作会互相覆盖，分歧率会被算低
  const pick = (tr) => new Map(tr.filter((r) => r.action && r.t > t0).map((r) => [`${r.id}@${r.t}`, r.action]));
  const a = pick(traceA);
  const b = pick(traceB);
  let n = 0;
  let diff = 0;
  for (const [k, act] of b) {
    if (!a.has(k)) continue;
    n += 1;
    if (a.get(k) !== act) diff += 1;
  }
  return { ticks: n, rate: n ? Number((diff / n).toFixed(4)) : 0 };
}

// O2 恢复动力学的观察侧。输入是同一个人的存续序列 [{t, v, reserve, ledger, ate}]（由 run.mjs 从 trace 取）。
// 回升事件 = 谷底之后净上升 ≥ minRebound。锯齿（吃一顿涨一截、之后慢慢掉）会算成多次回升，这是对的：
// 它正是"靠进食维持"的形状；而只降不升的序列必须报 0 次——这条是指标自身的负控，见 life.test.mjs。
export function recoveryStats(series, { crit = 0.6, minRebound = 0.05, eatWindow = 20, tailTicks = 200 } = {}) {
  const n = series.length;
  if (!n) return null;
  const num = (r, k) => (typeof r[k] === 'number' ? r[k] : 0);
  const drops = [];
  let seen = num(series[0], 'ledger');
  for (const r of series) {
    if (num(r, 'ledger') > seen) drops.push(r.t);
    seen = Math.max(seen, num(r, 'ledger'));
  }
  const rebounds = [];
  for (let i = 0; i < n;) {
    let low = i;
    while (low + 1 < n && series[low + 1].v <= series[low].v) low++;
    let high = low;
    while (high + 1 < n && series[high + 1].v >= series[high].v) high++;
    const gain = series[high].v - series[low].v;
    if (gain >= minRebound) {
      const t0 = series[low].t;
      rebounds.push({ t: t0, from: series[low].v, to: series[high].v, gain, crossedCrit: series[high].v >= crit, ateNear: series.some((r) => r.ate && r.t >= t0 && r.t <= t0 + eatWindow) });
    }
    i = high + 1; // 谷底与峰头都推进到峰之后：否则同一段上升会被数两次
  }
  const tEnd = series[n - 1].t;
  const tail = series.filter((r) => r.t >= tEnd - tailTicks);
  const mt = tail.reduce((s, r) => s + r.t, 0) / tail.length;
  const mv = tail.reduce((s, r) => s + r.v, 0) / tail.length;
  const cov = tail.reduce((s, r) => s + (r.t - mt) * (r.v - mv), 0);
  const varT = tail.reduce((s, r) => s + (r.t - mt) ** 2, 0);
  const firstDropT = drops.length ? drops[0] : null;
  const after = firstDropT === null ? [] : rebounds.filter((r) => r.t >= firstDropT);
  return {
    samples: n,
    drops: drops.length,
    firstDropT,
    reboundTotal: rebounds.length,
    reboundAfterDrop: after.length,
    maxReboundAfterDrop: after.length ? Math.max(...after.map((r) => r.gain)) : 0,
    crossedCritAfterDrop: after.some((r) => r.crossedCrit),
    ateCoupledShare: after.length ? after.filter((r) => r.ateNear).length / after.length : null,
    tailSlopePer100: varT ? (cov / varT) * 100 : 0,
    reserveShare: series.filter((r) => num(r, 'reserve') > 1e-9).length / n,
    // 进食频率是恢复的自变量：打平线（每百刻几顿才不掉）由机械侧给出，这里只报实测值
    meals: series.filter((r) => r.ate).length,
    mealsPer100: ((series.filter((r) => r.ate).length / Math.max(1, tEnd - series[0].t)) * 100),
    endV: series[n - 1].v,
    endReserve: num(series[n - 1], 'reserve'),
  };
}

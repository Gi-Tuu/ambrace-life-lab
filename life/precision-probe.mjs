// S4 独立探索探针，不是产品预测器，也不构成 P5 验收。
// 预先登记：seed 101–110，各 3 个体，400 与 1200 tick；预测下一次行动后
// arousal 是否高于本次（相等为 0）。只用本次 arousal 的四等宽档和动作类型，
// 每个个体独立在线计数，Beta(1,1) 冷启动；先预测、后观察、再更新。
// 报全部预测，不丢弃冷启动；时间序列不是独立样本。
// 基线为同样在线更新的无条件频率；零分布对每条轨迹作非零循环位移，
// 保留结果序列自身的自相关。它检验配对关系，不是校准的显著性检验。
import { simulate } from './run.mjs';
import { makeRng, hashSeed } from './rng.mjs';

const seeds = Array.from({ length: 10 }, (_, i) => 101 + i);
const permutations = 199;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = x => Number(x.toFixed(5));

function evaluate(rows) {
  const bins = Array.from({ length: 10 }, () => []);
  for (const row of rows) bins[Math.min(9, Math.floor(row.p * 10))].push(row);
  return {
    n: rows.length,
    brier: round(mean(rows.map(({ p, y }) => (p - y) ** 2))),
    baselineBrier: round(mean(rows.map(({ base, y }) => (base - y) ** 2))),
    reliability: bins.map((b, i) => ({ bin: i, n: b.length, forecast: b.length ? round(mean(b.map(x => x.p))) : null, observed: b.length ? round(mean(b.map(x => x.y))) : null })),
  };
}

function prequential(trace) {
  const counts = new Map();
  let successes = 0, total = 0;
  const rows = [];
  for (let i = 0; i + 1 < trace.length; i++) {
    const current = trace[i], next = trace[i + 1];
    const key = `${Math.min(3, Math.floor(current.m.arousal * 4))}:${current.kind}`;
    const [yes, n] = counts.get(key) ?? [0, 0];
    const p = (yes + 1) / (n + 2);
    const base = (successes + 1) / (total + 2);
    const y = Number(next.m.arousal > current.m.arousal);
    rows.push({ p, base, y });
    counts.set(key, [yes + y, n + 1]);
    successes += y; total++;
  }
  return rows;
}

for (const ticks of [400, 1200]) {
  const series = [];
  for (const seed of seeds) {
    const { agents } = await simulate({ seed, ticks });
    for (const agent of Object.values(agents)) {
      const trace = agent.trace.filter(r => r.action && r.m && Number.isFinite(r.m.arousal));
      series.push(prequential(trace));
    }
  }
  const observed = evaluate(series.flat());
  const rng = makeRng(hashSeed(741, ticks));
  const nulls = [];
  for (let k = 0; k < permutations; k++) {
    const shuffled = series.flatMap(rows => {
      if (rows.length < 2) return rows;
      const shift = 1 + Math.floor(rng() * (rows.length - 1));
      return rows.map((r, i) => ({ ...r, y: rows[(i + shift) % rows.length].y }));
    });
    nulls.push(evaluate(shuffled).brier);
  }
  nulls.sort((a, b) => a - b);
  console.log(JSON.stringify({ ticks, seeds, trajectories: series.length, observed,
    circularShiftNull: { permutations, brierMedian: nulls[Math.floor(permutations / 2)], brier5pct: nulls[Math.floor(permutations * 0.05)], pLowerOrEqual: (1 + nulls.filter(x => x <= observed.brier).length) / (permutations + 1) },
    caveat: '探索性轨迹预测；结果非独立，循环位移仅为配对关系参照，不证明校准或精度承重。' }));
}

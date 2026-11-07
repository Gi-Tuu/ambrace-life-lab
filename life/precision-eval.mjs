// S4 独立评估：相同的自主世界轨迹，在线一步预测，固定朴素持久性基线。
// 固定评估口径：前 100 tick 预热，事件为一步预测绝对误差 <= .03；
// 概率来自各预测器此前最多 100 个误差事件（Beta(1,1) 平滑），不把精度权重当概率。
// 每个 seed 的 40 tick 时间块按组同时交换 B/C 损失；该近似零分布保留块内及角色间相关性。
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { simulate } from './run.mjs';
import { PrecisionModel } from './precision-candidate.mjs';
import { DIMS } from './traits.mjs';
import { makeRng } from './rng.mjs';

const seeds = [7, 11, 21, 31, 41, 51, 61, 71];
const warmup = 100, windowSize = 100, tolerance = 0.03, blockSize = 40, permutations = 2000;
const rows = [];
const originalTick = Organism.prototype.tick;
const originalBankTick = ModulatorBank.prototype.tick;
try {
  for (const ticks of [400, 1200]) for (const seed of seeds) {
    const models = new Map(), histories = new Map();
    let active = null;
    Organism.prototype.tick = async function(world) {
      active = { id: this.id, t: world.t };
      try { return await originalTick.call(this, world); }
      finally { active = null; }
    };
    ModulatorBank.prototype.tick = function(...args) {
      if (!active) throw new Error('评估器缺少角色上下文');
      const { id, t } = active;
      if (!models.has(id)) {
        models.set(id, new PrecisionModel());
        histories.set(id, Object.fromEntries(DIMS.map(d => [d, { b: [], c: [] }])));
      }
      const model = models.get(id), history = histories.get(id);
      const previous = this.snapshot(), forecast = model.predict(previous, true);
      const result = originalBankTick.apply(this, args);
      const actual = this.snapshot();
      for (const d of DIMS) {
        const hb = history[d].b, hc = history[d].c;
        const pb = (1 + hb.reduce((a, x) => a + x, 0)) / (2 + hb.length);
        const pc = (1 + hc.reduce((a, x) => a + x, 0)) / (2 + hc.length);
        const eb = actual[d] - previous[d], ec = actual[d] - forecast[d];
        const yb = Number(Math.abs(eb) <= tolerance), yc = Number(Math.abs(ec) <= tolerance);
        if (t > warmup) rows.push({ ticks, seed, t, id, dim: d, bMse: eb * eb, cMse: ec * ec, pb, pc, yb, yc });
        hb.push(yb); hc.push(yc); if (hb.length > windowSize) hb.shift(); if (hc.length > windowSize) hc.shift();
      }
      model.observe(previous, forecast, actual);
      return result;
    };
    await simulate({ seed, ticks, condition: 'C2' });
  }
} finally { Organism.prototype.tick = originalTick; ModulatorBank.prototype.tick = originalBankTick; }

function avg(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function reliability(rs, p, y) {
  return Array.from({ length: 5 }, (_, i) => {
    const bin = rs.filter(r => Math.min(4, Math.floor(r[p] * 5)) === i);
    return { bin: `[${(i / 5).toFixed(1)},${((i + 1) / 5).toFixed(1)}${i === 4 ? ']' : ')'} `, n: bin.length, predicted: bin.length ? avg(bin.map(r => r[p])) : null, observed: bin.length ? avg(bin.map(r => r[y])) : null };
  });
}
function summarize(ticks, dim) {
  const rs = rows.filter(r => r.ticks === ticks && r.dim === dim);
  const blocks = new Map();
  for (const r of rs) {
    const key = `${r.seed}:${Math.floor((r.t - warmup - 1) / blockSize)}`;
    const x = blocks.get(key) ?? { sum: 0, n: 0 };
    x.sum += r.bMse - r.cMse; x.n++; blocks.set(key, x);
  }
  const values = [...blocks.values()], observed = avg(rs.map(r => r.bMse - r.cMse));
  const rng = makeRng(90210 + ticks + DIMS.indexOf(dim));
  let extreme = 0;
  for (let j = 0; j < permutations; j++) {
    const diff = values.reduce((s, x) => s + (rng() < 0.5 ? -x.sum : x.sum), 0) / rs.length;
    if (diff >= observed) extreme++;
  }
  return { ticks, dim, n: rs.length, blocks: values.length, mseB: avg(rs.map(r => r.bMse)), mseC: avg(rs.map(r => r.cMse)), mseGainBminusC: observed, blockSwapOneSidedP: (extreme + 1) / (permutations + 1), brierB: avg(rs.map(r => (r.pb - r.yb) ** 2)), brierC: avg(rs.map(r => (r.pc - r.yc) ** 2)), reliabilityB: reliability(rs, 'pb', 'yb'), reliabilityC: reliability(rs, 'pc', 'yc') };
}
console.log(JSON.stringify({ protocol: { seeds, ticks: [400, 1200], warmup, windowSize, tolerance, blockSize, permutations, event: '预测误差绝对值不超过 0.03', baseline: '上刻实测值', probability: '该预测器历史命中率的 Beta(1,1) 平滑', source: 'C2 自主世界同一轨迹，仅 bank.tick 执行时，预测先于 bank.tick 和观察更新；反射提前返回无样本', null: '按 seed 和时间块同时交换 B/C 的 MSE，单侧检验' }, results: [400, 1200].flatMap(t => DIMS.map(d => summarize(t, d))), limitations: ['pending 注入在 bank.tick 前发生，预测只取旧状态，与产品一致，未读取 pending；执行结果产生的注入留待后续 bank.tick。', '两模型的命中事件各自以其预测为中心，Brier 不能直接解释为同一事件的两模型优劣。', '块交换假定块在零假设下可交换，连续块仍可能相关；多重比较未经校正。', '在线历史跟随被评估样本更新，并非独立留出训练；仅评估同一世界轨迹预测，不证明闭环行为因果。', '零分布检验 MSE 差；可靠性分桶中的样本有时序及个体相关，样本数不等于独立样本数。'] }, null, 2));

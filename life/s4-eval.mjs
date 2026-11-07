// S4 前向预测的同轨迹评估：严格先预测，随后运行真实 bank.tick，再在线更新。
// 比较固定事件 next > current；行为受精度影响的闭环验证须单独执行。
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { simulate } from './run.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';

const seeds = [101, 103, 107, 109, 113, 127, 131, 137];
const warmup = 100, maxTicks = 1200, windows = [400, 1200], historyWindow = 100;
const rows = [];
const agentTick = Organism.prototype.tick, bankTick = ModulatorBank.prototype.tick;
try {
  for (const seed of seeds) {
    const models = new Map(), histories = new Map();
    let active = null;
    Organism.prototype.tick = async function(world) {
      active = { id: this.id, t: world.t };
      try { return await agentTick.call(this, world); } finally { active = null; }
    };
    ModulatorBank.prototype.tick = function(...args) {
      if (!active) throw Error('missing organism context');
      const { id, t } = active;
      if (!models.has(id)) {
        models.set(id, new ForwardModel());
        histories.set(id, Object.fromEntries(DIMS.map(d => [d, []])));
      }
      const model = models.get(id), history = histories.get(id);
      // 输入是当前 tick 前已有信号；复制 pending，防止 tick 清空后污染样本。
      const input = { m: this.snapshot(), pending: { ...this.pending }, traits: this.traits };
      const prediction = model.predict(input);
      const result = bankTick.apply(this, args);
      const actual = this.snapshot();
      for (const d of DIMS) {
        const h = history[d], y = Number(actual[d] > input.m[d]);
        const pb = (1 + h.reduce((a, b) => a + b, 0)) / (2 + h.length);
        const pc = prediction.probability[d], mu = prediction.mu[d];
        if (!Number.isFinite(pc) || pc < 0 || pc > 1 || !Number.isFinite(mu)) throw Error(`invalid forecast ${d}: ${pc}, ${mu}`);
        if (t > warmup) rows.push({ seed, t, id, d, y, pb, pc, bMse: (actual[d] - input.m[d]) ** 2, cMse: (actual[d] - mu) ** 2 });
        if (t <= warmup) { h.push(y); if (h.length > historyWindow) h.shift(); }
      }
      if (t <= warmup) model.observe(input, prediction, actual);
      return result;
    };
    await simulate({ seed, ticks: maxTicks, condition: 'C2', channelMask: { forwardModel: 0, forwardLearn: 0, precision: 0 } });
  }
} finally { Organism.prototype.tick = agentTick; ModulatorBank.prototype.tick = bankTick; }

const mean = xs => xs.reduce((a,b) => a+b, 0) / xs.length;
function bins(rs, p) {
  return Array.from({length: 5}, (_, i) => {
    const selected = rs.filter(r => Math.min(4, Math.floor(r[p] * 5)) === i);
    return { range: `${i / 5}-${(i + 1) / 5}`, n: selected.length, meanProbability: selected.length ? mean(selected.map(r => r[p])) : null, observed: selected.length ? mean(selected.map(r => r.y)) : null };
  });
}
// 每个 seed 为一独立单元，完整枚举配对符号交换；非 tick 独立性假设。
function paired(seedDiffs) {
  const observed = mean(seedDiffs), total = 1 << seedDiffs.length;
  let extreme = 0;
  for (let mask=0; mask<total; mask++) {
    const v = mean(seedDiffs.map((x,i) => mask & (1 << i) ? x : -x));
    if (v >= observed - 1e-15) extreme++;
  }
  return { perSeed: seedDiffs, mean: observed, oneSidedExactSignFlipP: extreme / total };
}
function summarize(ticks, d) {
  const rs = rows.filter(r => r.t <= ticks && r.d === d);
  const means = (key) => mean(rs.map(r => r[key]));
  const brierB = r => (r.pb-r.y)**2, brierC = r => (r.pc-r.y)**2;
  const diffs = fn => seeds.map(seed => mean(rs.filter(r=>r.seed===seed).map(fn)));
  return { ticks, dimension: d, n: rs.length, baselineMse: means('bMse'), modelMse: means('cMse'), mseGain: paired(diffs(r=>r.bMse-r.cMse)), baselineBrier: mean(rs.map(brierB)), modelBrier: mean(rs.map(brierC)), brierGain: paired(diffs(r=>brierB(r)-brierC(r))), baselineReliability: bins(rs, 'pb'), modelReliability: bins(rs, 'pc') };
}
console.log(JSON.stringify({ protocol: { seeds, windows, warmup, historyWindow, target: 'actual next state > pre-tick state', meanBaseline: 'pre-tick state', probabilityBaseline: 'prior same-agent binary frequency in last 100 updates, Beta(1,1)', candidate: 'pre-tick state, pending, traits; then online residual learning', null: 'paired sign flips over 8 seed-level mean improvements, exact 256 permutations', source: 'same C2 trajectories with S4 channels disabled, bank.tick only', timing: 'first 100 world ticks train per-agent model and baseline; freeze both throughout held-out future ticks; disjoint seeds from earlier exploratory 7,11,21,31,41,51,61,71' }, results: windows.flatMap(t=>DIMS.map(d=>summarize(t,d))), limitations: ['Same-trajectory offline replay, not independent closed-loop or behavior validation.', 'Test seed warmup trains local state only; held-out subsequent ticks are frozen, but seeds share the same simulation structure.', 'Sign flips assume seed-level paired differences are exchangeable under the null; 8 seeds limit resolution and power.', 'Eight dimension/window comparisons are exploratory and not multiplicity adjusted; 400 and 1200 windows overlap.', 'Reliability bin sample counts are correlated within trajectories, not independent observations.', 'Clamping at 0 and 1 introduces point masses and may affect probability calibration.', 'Candidate uses known pending inputs and traits while baseline deliberately uses only state/history; baseline tests predictive value, not equal information.'] }, null, 2));

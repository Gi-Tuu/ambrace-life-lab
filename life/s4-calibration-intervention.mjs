// P5 第二方向：同一真实轨迹、同一事件、同一冻结误差方差，只干预预测均值 μ。
// ±0.01 是事先指定的诊断干预，不是对模型进行重新训练或给其概率校准。
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { simulate } from './run.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';

const seeds = [101, 103, 107, 109, 113, 127, 131, 137];
const warmup = 100, ticks = 1200, offset = 0.01, windows = [400, 1200];
const rows = [], origAgentTick = Organism.prototype.tick, origBankTick = ModulatorBank.prototype.tick;
const mean = x => x.reduce((s,v) => s+v, 0) / x.length;
function cdf(z) {
  const a = Math.abs(z), t = 1 / (1 + 0.2316419 * a);
  const tail = Math.exp(-a*a/2) / Math.sqrt(2*Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1-tail : tail;
}
function probability(current, mu, r) {
  if (current >= 1) return 0;
  if (r.n < 2) return 0.5;
  const variance = r.m2 / (r.n - 1);
  return cdf((mu + r.meanError - current) / Math.sqrt(Math.max(variance, 1e-12)));
}
try {
  for (const seed of seeds) {
    const models = new Map(); let active = null;
    Organism.prototype.tick = async function(world) {
      active = { id: this.id, t: world.t };
      try { return await origAgentTick.call(this, world); } finally { active = null; }
    };
    ModulatorBank.prototype.tick = function(...args) {
      if (!active) throw new Error('missing organism context');
      const { id, t } = active;
      if (!models.has(id)) models.set(id, new ForwardModel());
      const model = models.get(id), input = { m: this.snapshot(), pending: { ...this.pending }, traits: this.traits };
      const prediction = model.predict(input), before = model.dump();
      const p = {};
      for (const d of DIMS) {
        const r = before[d], mu = prediction.mu[d];
        p[d] = { base: probability(input.m[d], mu, r), plus: probability(input.m[d], Math.min(1, mu + offset), r), minus: probability(input.m[d], Math.max(0, mu - offset), r) };
        if (Math.abs(p[d].base - prediction.probability[d]) > 1e-12) throw new Error('probability implementation differs from model');
      }
      const result = origBankTick.apply(this, args), actual = this.snapshot();
      if (t > warmup) for (const d of DIMS) rows.push({ seed, t, d, y: Number(actual[d] > input.m[d]), ...p[d] });
      if (t <= warmup) model.observe(input, prediction, actual);
      return result;
    };
    await simulate({ seed, ticks, condition: 'C2', channelMask: { forwardModel: 0, forwardLearn: 0, precision: 0 } });
  }
} finally { Organism.prototype.tick = origAgentTick; ModulatorBank.prototype.tick = origBankTick; }
function bins(rs, arm) {
  return Array.from({length:5}, (_,i) => {
    const b = rs.filter(r => Math.min(4,Math.floor(r[arm]*5)) === i);
    return { interval:`${i/5}-${(i+1)/5}`, n:b.length, predicted:b.length ? mean(b.map(r=>r[arm])) : null, observed:b.length ? mean(b.map(r=>r.y)) : null };
  });
}
function summary(end, d) {
  const rs = rows.filter(r => r.t <= end && r.d === d);
  const loss = (r, k) => (r[k] - r.y) ** 2;
  const arms = Object.fromEntries(['base','plus','minus'].map(k => [k,{brier:mean(rs.map(r=>loss(r,k))), reliability:bins(rs,k)}]));
  const diffs = Object.fromEntries(['plus','minus'].map(k => [k, seeds.map(seed => mean(rs.filter(r=>r.seed===seed).map(r=>loss(r,k)-loss(r,'base'))))]));
  return { window:end, dimension:d, n:rs.length, arms, brierDifferenceVsBaseBySeed:diffs, brierDifferenceVsBase:Object.fromEntries(Object.entries(diffs).map(([k,v])=>[k,mean(v)])) };
}
console.log(JSON.stringify({ protocol:{seeds,ticks,windows,warmup,offset,target:'actual next > pre-tick state', source:'same C2 trajectories with all S4 channels disabled; actual bank.tick updates only', intervention:'frozen predictor mean plus/minus 0.01 clipped to [0,1]; unchanged per-channel residual mean, variance and precision; same normal CDF as candidate', training:'train on first 100 world ticks then freeze for held-out trajectory', unit:'seed-level paired mean Brier differences; reliability bins list observation count rather than independent sample count'}, results:windows.flatMap(w=>DIMS.map(d=>summary(w,d))), limitations:['Artificial mean perturbations establish sensitivity of calibration metrics to μ under fixed variance; they do not prove naturally learned μ is calibrated or that a π intervention changes behavior.', 'Window overlap and serially correlated samples limit inference; per-seed paired differences expose variation without asserting tick independence.', 'Normal CDF is an approximation; clamping creates boundary point masses.'] },null,2));

import { DIMS } from './traits.mjs';
import { hill } from './modulators.mjs';

// 在线线性前向模型：输入只包含本次 bank.tick 之前可见的状态与待注入量。
// RLS 估计每维的下一步变化；参数只从已完成的更新中学习。
const N = DIMS.length + 3;
const clamp = x => Math.max(0, Math.min(1, x));
function features(d, { m, pending, traits }) {
  const x = k => m[k] - traits.baseline[k];
  const injection = Math.max(-traits.U_max, Math.min(traits.U_max, pending[d] ?? 0));
  return [1, 100 * x(d) / traits.tau[d], ...DIMS.map(k => 0.1 * hill(x(k))), 10 * injection];
}
function normalCdf(z) {
  const a = Math.abs(z), t = 1 / (1 + 0.2316419 * a);
  const tail = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}
function fresh() {
  return { theta: Array(N).fill(0), P: Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => i === j ? 1000 : 0)), n: 0, meanError: 0, m2: 0 };
}
export class ForwardModel {
  constructor() { this.rows = Object.fromEntries(DIMS.map(d => [d, fresh()])); }
  predict(input, { precision: usePrecision = true } = {}) {
    const mu = {}, probability = {}, precision = {}, weights = {};
    // Pooled variance is calculated only from observations already available before prediction.
    // Within-channel residual sums retain each channel's own historical mean.
    const dof = DIMS.reduce((n, d) => n + Math.max(0, this.rows[d].n - 1), 0);
    const pooled = dof ? DIMS.reduce((s, d) => s + this.rows[d].m2, 0) / dof : null;
    for (const d of DIMS) {
      const row = this.rows[d], f = features(d, input);
      mu[d] = clamp(input.m[d] + row.theta.reduce((s, v, i) => s + v * f[i], 0));
      // 样本不足时没有概率依据；0.5 表达未判定，而不是以固定值伪装学习。
      const variance = usePrecision ? (row.n > 1 ? row.m2 / (row.n - 1) : null) : pooled;
      precision[d] = variance === null ? null : 1 / Math.max(variance, 1e-12);
      probability[d] = input.m[d] >= 1 ? 0 : variance === null ? 0.5 : normalCdf((mu[d] + row.meanError - input.m[d]) / Math.sqrt(Math.max(variance, 1e-12)));
    }
    const finite = Object.values(precision).filter(v => v !== null);
    const maxPrecision = finite.length ? Math.max(...finite) : null;
    for (const d of DIMS) weights[d] = !usePrecision || maxPrecision === null || precision[d] === null ? 1 : precision[d] / maxPrecision;
    return { mu, probability, precision, weights };
  }
  observe(input, prediction, actual) {
    for (const d of DIMS) {
      const row = this.rows[d], f = features(d, input), err = actual[d] - prediction.mu[d];
      row.n++;
      const diff = err - row.meanError;
      row.meanError += diff / row.n;
      row.m2 += diff * (err - row.meanError);
      const pf = row.P.map(r => r.reduce((s, v, i) => s + v * f[i], 0));
      const denominator = 1 + f.reduce((s, v, i) => s + v * pf[i], 0);
      const target = actual[d] - input.m[d];
      const residual = target - row.theta.reduce((s, v, i) => s + v * f[i], 0);
      row.theta = row.theta.map((v, i) => v + pf[i] * residual / denominator);
      row.P = row.P.map((r, i) => r.map((v, j) => v - pf[i] * pf[j] / denominator));
    }
  }
  dump() { return structuredClone(this.rows); }
  load(data) {
    if (!data) return;
    // Only accept complete and finite records, so legacy or damaged saves cannot poison predictions.
    for (const d of DIMS) {
      const r = data[d];
      if (r && Number.isInteger(r.n) && r.n >= 0 && Number.isFinite(r.meanError) && Number.isFinite(r.m2) && r.m2 >= 0 && Array.isArray(r.theta) && r.theta.length === N && r.theta.every(Number.isFinite) && Array.isArray(r.P) && r.P.length === N && r.P.every(x => Array.isArray(x) && x.length === N && x.every(Number.isFinite))) this.rows[d] = structuredClone(r);
    }
  }
}

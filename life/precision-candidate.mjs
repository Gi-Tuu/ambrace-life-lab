import { DIMS } from './traits.mjs';

// 单步在线预测：先由旧状态和已学平均变化量预测，再用新状态更新误差。
export class PrecisionModel {
  constructor() {
    this.delta = Object.fromEntries(DIMS.map(d => [d, 0]));
    this.error = Object.fromEntries(DIMS.map(d => [d, 0]));
    this.count = Object.fromEntries(DIMS.map(d => [d, 0]));
  }
  predict(previous, useModel = true) { return Object.fromEntries(DIMS.map(d => [d, Math.max(0, Math.min(1, previous[d] + (useModel ? this.delta[d] : 0)))])); }
  observe(previous, forecast, actual) {
    for (const d of DIMS) {
      const n = ++this.count[d];
      const rate = 1 / Math.min(n, 40);
      this.delta[d] += rate * ((actual[d] - previous[d]) - this.delta[d]);
      this.error[d] += rate * (Math.abs(actual[d] - forecast[d]) - this.error[d]);
    }
  }
  weights() { return Object.fromEntries(DIMS.map(d => [d, this.count[d] ? 1 / (1 + 10 * this.error[d]) : 1])); }
  dump() { return { delta: { ...this.delta }, error: { ...this.error }, count: { ...this.count } }; }
  load(x) { if (!x) return; for (const key of ['delta', 'error', 'count']) for (const d of DIMS) if (Number.isFinite(x[key]?.[d])) this[key][d] = x[key][d]; }
}

// L3 调制层。它是内部状态的唯一真相源（§2.1 依赖铁律 1）。
import { DIMS } from './traits.mjs';
import { gauss } from './rng.mjs';

const K = 0.5;
const NHILL = 2;

// 剂量-反应饱和：避免线性堆叠（三次负面事件 ⇒ 永久崩溃）
export function hill(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  return (s * Math.pow(a, NHILL)) / (Math.pow(K, NHILL) + Math.pow(a, NHILL));
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class ModulatorBank {
  constructor(traits, rng, override) {
    this.traits = traits;
    this.rng = rng;
    this.m = {};
    for (const d of DIMS) this.m[d] = override?.[d] ?? traits.baseline[d];
    this.pending = {};
    for (const d of DIMS) this.pending[d] = 0;
  }

  x(d) {
    return this.m[d] - this.traits.baseline[d];
  }

  tick(dt = 1) {
    const t = this.traits;
    for (const d of DIMS) {
      let cross = 0;
      for (let j = 0; j < DIMS.length; j++) {
        const w = t.w[DIMS.indexOf(d)]?.[j] ?? 0;
        cross += w * hill(this.x(DIMS[j]));
      }
      const decay = -this.x(d) / t.tau[d];
      const inj = Math.max(-t.U_max, Math.min(t.U_max, this.pending[d]));
      this.m[d] = clamp01(this.m[d] + dt * (decay + cross + inj) + gauss(this.rng) * t.noise[d] * dt);
      this.pending[d] = 0;
    }
  }

  inject(spec) {
    for (const [d, v] of Object.entries(spec)) if (d in this.m) this.pending[d] += v;
  }

  snapshot() {
    return { ...this.m };
  }

  // C3：调制态入档（含 pending），读档后不改变下一次决策。
  restore(m) {
    if (!m || typeof m !== 'object') return;
    for (const d of DIMS) if (Number.isFinite(m[d])) this.m[d] = clamp01(m[d]);
  }

  // 离散化摘要：C2-neg 只允许这一层进入提示词，且不得进入四个通道
  summary() {
    const word = (v) => (v < 0.33 ? '低' : v < 0.66 ? '中' : '高');
    return `警觉${word(this.m.arousal)}、趋近${word(this.m.approach)}、自制${word(this.m.inhibit)}、闲感${word(this.m.quiescence)}`;
  }
}

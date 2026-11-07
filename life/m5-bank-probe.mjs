// 接线前探针：复制 ModulatorBank 的更新顺序和边界，仅供对候选做拒绝测试，不是生产接入。
import { ModulatorBank, hill } from './modulators.mjs';
import { SlowMechanics, M5_DEFAULTS } from './m5-slow.mjs';
import { DIMS, sampleTraits } from './traits.mjs';
import { makeRng, gauss } from './rng.mjs';

export class ProbeBank extends ModulatorBank {
  constructor(traits, rng, options) {
    super(traits, rng);
    this.slow = new SlowMechanics(options);
  }
  tick(dt = 1) {
    const t = this.traits;
    for (const d of DIMS) {
      let cross = 0;
      for (let j = 0; j < DIMS.length; j++) cross += (t.w[DIMS.indexOf(d)]?.[j] ?? 0) * hill(this.x(DIMS[j]));
      let decay = -this.x(d) / t.tau[d];
      const inj = Math.max(-t.U_max, Math.min(t.U_max, this.pending[d]));
      let feedback = 0;
      if (d === 'arousal' && this.slow.enabled) {
        const state = this.slow.tick({ fast: 0, stress: inj });
        feedback = state.fast - inj;
        decay /= 1 + M5_DEFAULTS.loadGain * state.load;
      }
      this.m[d] = Math.max(0, Math.min(1, this.m[d] + dt * (decay + cross + inj + feedback) + gauss(this.rng) * t.noise[d] * dt));
      this.pending[d] = 0;
    }
  }
}
export function probe({archetype, seed, double, align, options = {}, cross = true, noise = true}) {
  const traits = sampleTraits(makeRng(seed), archetype);
  if (!cross) traits.w = traits.w.map((row) => row.map(() => 0));
  if (!noise) for (const d of DIMS) traits.noise[d] = 0;
  const make = () => new ProbeBank(traits, makeRng(seed + 10000), options);
  const actual = make(), reference = make();
  let peak = 0, consecutive = 0, recovery = null;
  for (let t = 1; t <= 600; t++) {
    if (t === 80 || (double && t === 20)) actual.inject({ arousal: .25 });
    actual.tick(); reference.tick();
    if (t === 79 && align) Object.assign(actual.m, reference.m);
    if (t >= 80) {
      const delta = Math.abs(actual.m.arousal - reference.m.arousal);
      peak = Math.max(peak, delta);
      consecutive = delta <= .02 ? consecutive + 1 : 0;
      if (recovery === null && peak > .02 && consecutive >= 5) recovery = t - 80 - 4;
    }
  }
  return { archetype, seed, double, align, options, tau: traits.tau.arousal, U_max: traits.U_max, peak, recovery, censored: recovery === null };
}
if (import.meta.url === new URL(`file:///${process.argv[1]?.replaceAll('\\','/')}`).href) {
const rows = [];
for (const archetype of ['谨慎', '冲动', '孤僻'])
  for (const seed of [7,11,13,23,42])
    for (const align of [false, true])
      for (const options of [{}, {load:false}, {enabled:false}])
        for (const double of [false,true]) rows.push(probe({archetype,seed,double,align,options}));
console.log(JSON.stringify({protocol:'四维真实参数与噪声；600 次更新；20/80 注入 .25 并按 U_max 截断；偏差≤.02 连续5次',rows},null,2));
}

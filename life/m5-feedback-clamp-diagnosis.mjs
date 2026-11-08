// 非生产探针：只改变输出钳制及指定回边；输入钳制、更新次序和随机流保持原样。
import assert from 'node:assert/strict';
import { ProbeBank, probe } from './m5-bank-probe.mjs';
import { hill } from './modulators.mjs';
import { M5_DEFAULTS } from './m5-slow.mjs';
import { DIMS, sampleTraits } from './traits.mjs';
import { makeRng, gauss } from './rng.mjs';

class TracedBank extends ProbeBank {
  constructor(traits, rng, options, bounded) {
    super(traits, rng, options); this.bounded = bounded; this.boundary = 0; this.maxAbs = 0;
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
        feedback = state.fast - inj; decay /= 1 + M5_DEFAULTS.loadGain * state.load;
      }
      const raw = this.m[d] + dt * (decay + cross + inj + feedback) + gauss(this.rng) * t.noise[d] * dt;
      if (!Number.isFinite(raw)) throw new RangeError(`非有限状态：${d}`);
      if (raw < 0 || raw > 1) this.boundary++;
      this.maxAbs = Math.max(this.maxAbs, Math.abs(raw));
      this.m[d] = this.bounded ? Math.max(0, Math.min(1, raw)) : raw;
      this.pending[d] = 0;
    }
  }
}
function run(archetype, seed, edge, bounded, enabled) {
  const traits = sampleTraits(makeRng(seed), archetype);
  if (!edge) traits.w[0][3] = 0;
  const options = { enabled };
  const banks = Array.from({length:3}, () => new TracedBank(traits, makeRng(seed+10000), options, bounded));
  const shadows = bounded ? Array.from({length:3}, () => new ProbeBank(traits, makeRng(seed+10000), options)) : [];
  const history = [];
  for (let t=1; t<=600; t++) {
    for (const group of [banks, shadows]) {
      if (!group.length) continue;
      if (t===20) group[1].inject({arousal:.25});
      if (t===80) for (const i of [0,1]) group[i].inject({arousal:.25});
      for (const b of group) b.tick();
      if (t===79) for (const i of [0,1]) Object.assign(group[i].m, group[2].m);
    }
    for (let i=0; i<shadows.length; i++) {
      assert.deepEqual(banks[i].m, shadows[i].m, `原探针快状态不一致 ${archetype}/${seed}/${t}/${i}`);
      assert.deepEqual(banks[i].slow.dump(), shadows[i].slow.dump(), `原探针慢状态不一致 ${archetype}/${seed}/${t}/${i}`);
    }
    if (t>=80) history.push({t, single: Math.abs(banks[0].m.arousal-banks[2].m.arousal),
      double: Math.abs(banks[1].m.arousal-banks[2].m.arousal),
      between: Math.abs(banks[0].m.arousal-banks[1].m.arousal),
      same: DIMS.every(d=>Object.is(banks[0].m[d],banks[1].m[d]))});
  }
  function measure(k) {
    let peak=0, consecutive=0, recovery=null;
    for (const h of history) {
      peak=Math.max(peak,h[k]); consecutive=h[k]<=.02?consecutive+1:0;
      if(recovery===null&&peak>.02&&consecutive>=5)recovery=h.t-80-4;
    }
    return {recovery, censored:recovery===null,
      afterOut:recovery===null?null:history.filter(h=>h.t>80+recovery+4&&h[k]>.02).length};
  }
  const out={archetype,seed,edge,bounded,enabled,single:measure('single'),double:measure('double'),
    maxBetween:Math.max(...history.map(h=>h.between)),allDimensionsMatch:history.every(h=>h.same),
    boundary:banks.map(b=>b.boundary),maxAbs:banks.map(b=>b.maxAbs)};
  if(!enabled)assert.equal(out.allDimensionsMatch,true,'关闭慢层的负控失败');
  if(edge&&bounded)for(const isDouble of [false,true]) {
    const orig=probe({archetype,seed,double:isDouble,align:true,options});
    assert.equal(out[isDouble?'double':'single'].recovery,orig.recovery,'未复现原红闸门');
  }
  return out;
}
const arms=[{edge:true,bounded:true,enabled:true},{edge:true,bounded:false,enabled:true},
 {edge:false,bounded:true,enabled:true},{edge:false,bounded:false,enabled:true},
 {edge:true,bounded:true,enabled:false},{edge:true,bounded:false,enabled:false}];
const rows=[];
for(const arm of arms)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of [7,11,13,23,42])
  rows.push(run(archetype,seed,arm.edge,arm.bounded,arm.enabled));
console.log(JSON.stringify({protocol:'探索诊断，非验收：600 次更新；仅干预回边与输出钳制',rows},null,2));

// 仅诊断：保持原判据；切边是受控假设实验，不接入生产世界。
import assert from 'node:assert/strict';
import { ProbeBank, probe } from './m5-bank-probe.mjs';
import { DIMS, sampleTraits } from './traits.mjs';
import { makeRng } from './rng.mjs';

function pair(archetype, seed, arm) {
  const traits = sampleTraits(makeRng(seed), archetype);
  if (arm === 'break-return') traits.w[0][3] = 0;
  if (arm === 'no-cross') traits.w = traits.w.map(row => row.map(() => 0));
  const options = arm === 'disabled' ? { enabled: false } : {};
  const make = () => new ProbeBank(traits, makeRng(seed + 10000), options);
  const single = make(), double = make(), reference = make();
  const history = [];
  for (let t = 1; t <= 600; t++) {
    if (t === 20) double.inject({ arousal: .25 });
    if (t === 80) for (const b of [single, double]) b.inject({ arousal: .25 });
    single.tick(); double.tick(); reference.tick();
    if (t === 79) for (const b of [single, double]) Object.assign(b.m, reference.m);
    if (t >= 80) history.push({ t, single: Math.abs(single.m.arousal - reference.m.arousal),
      double: Math.abs(double.m.arousal - reference.m.arousal),
      between: Math.abs(single.m.arousal - double.m.arousal),
      sameAll: DIMS.every(d => Object.is(single.m[d], double.m[d])) });
  }
  function measure(k) {
    let peak = 0, consecutive = 0, recovery = null;
    for (const h of history) {
      peak = Math.max(peak, h[k]);
      consecutive = h[k] <= .02 ? consecutive + 1 : 0;
      if (recovery === null && peak > .02 && consecutive >= 5) recovery = h.t - 80 - 4;
    }
    return { recovery, censored: recovery === null,
      afterConfirmationOutOfBand: recovery === null ? null : history.filter(h => h.t > 80 + recovery + 4 && h[k] > .02).length };
  }
  const result = { archetype, seed, arm, single: measure('single'), double: measure('double'),
    maxBetween: Math.max(...history.map(h => h.between)), allDimensionsMatch: history.every(h => h.sameAll) };
  if (arm === 'disabled') assert.equal(result.allDimensionsMatch, true, '关闭层后受击快轨迹不相同');
  if (arm === 'full' || arm === 'disabled' || arm === 'no-cross') {
    for (const isDouble of [false, true]) {
      const prior = probe({ archetype, seed, double: isDouble, align: true, options,
        cross: arm !== 'no-cross' });
      assert.equal(result[isDouble ? 'double' : 'single'].recovery, prior.recovery, '未复现既有 probe');
    }
  }
  return result;
}
const rows = [];
for (const arm of ['full','break-return','no-cross','disabled'])
  for (const archetype of ['谨慎','冲动','孤僻'])
    for (const seed of [7,11,13,23,42]) rows.push(pair(archetype,seed,arm));
console.log(JSON.stringify({protocol:'探索诊断，非验收：600 更新，末击前快变量对齐；保留慢状态', rows},null,2));

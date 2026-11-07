// M4 附带代价表：把既有判据在 coupling 关/开两档各跑一遍，看新通道是否把旧结论挤坏。
// 口径与 §16.4 一致：两档共用同一个组名（决策量纲必须相同，自变量只有掩码），
// 并且 hashSeed 把掩码编进种子 ⇒ 这里报的是"各自档内的判据是否成立"，不是同种子逐位对照。
import { p1a, p2, p3, simulate } from './run.mjs';
import { driverDist } from './metrics.mjs';
import { p2Intervention, assertCutNegative } from './s4-p2-intervention.mjs';
import { PARAMS } from './params.mjs';

const SEEDS = [7, 11, 13, 23, 42];
const TICKS = 400;
const GROUP = '附带代价';
const avg = (xs, f) => Number((xs.reduce((s, x) => s + f(x), 0) / xs.length).toFixed(3));

async function arm(coupling) {
  const mask = { coupling };
  const kl = [], p2rows = [], covC2 = [], covC0 = [], driver = [], misc = [];
  for (const seed of SEEDS) {
    const one = await p1a({ seed, ticks: 320, condition: 'C2', channelMask: mask, group: GROUP });
    kl.push(one.meanKl);
    const two = await p2({ seed, ticks: TICKS, condition: 'C2', channelMask: mask, group: GROUP });
    p2rows.push(...Object.values(two));
    const c2 = await p3({ seed, ticks: TICKS, condition: 'C2', channelMask: mask, group: GROUP });
    const c0 = await p3({ seed, ticks: TICKS, condition: 'C0', group: GROUP });
    covC2.push(avg(Object.values(c2), (x) => x.coverage));
    covC0.push(avg(Object.values(c0), (x) => x.coverage));
    const { agents } = await simulate({ seed, ticks: TICKS, condition: 'C2', channelMask: mask, group: GROUP });
    const list = Object.values(agents);
    driver.push(driverDist(list.flatMap((a) => a.trace)));
    const counters = list.reduce((s, a) => { for (const k of Object.keys(a.counters)) s[k] = (s[k] ?? 0) + a.counters[k]; return s; }, {});
    const iv = await p2Intervention({ seeds: [seed], ticks: TICKS, channelMask: mask });
    assertCutNegative(iv.rows);
    misc.push({
      决策: counters.actions,
      驳回率: Number((counters.rejected / Math.max(1, counters.actions)).toFixed(3)),
      越轨: counters.normbreak,
      末存续: avg(list, (a) => a.viab.v),
      P2干预TV: iv.bySeed[0].meanTv,
      P2切断TV: Number(iv.bySeed[0].maxCutTv.toFixed(12)),
      耦合应用: counters.couplingApplied ?? 0,
    });
  }
  return {
    P1aKL: avg(kl, (x) => x),
    P2静默熵: avg(p2rows, (x) => x.静默熵),
    P2互信息: avg(p2rows, (x) => x.互信息),
    'P2耦合(是/否)': `${p2rows.filter((x) => x.耦合 === '是').length}/${p2rows.length}`,
    P2审议率: avg(p2rows, (x) => x.审议率),
    P3余量: Number((avg(covC2, (x) => x) - avg(covC0, (x) => x)).toFixed(3)),
    行动来源: driver.reduce((acc, d) => { for (const [k, v] of Object.entries(d)) acc[k] = Number((((acc[k] ?? 0) + v) / SEEDS.length).toFixed(3)); return acc; }, {}),
    明细: misc,
    驳回率: avg(misc, (x) => x.驳回率),
    P2干预TV: avg(misc, (x) => x.P2干预TV),
    末存续: avg(misc, (x) => x.末存续),
    耦合应用: misc.reduce((s, x) => s + x.耦合应用, 0),
  };
}

const off = await arm(0);
const on = await arm(1);
const KEYS = ['P1aKL', 'P2静默熵', 'P2互信息', 'P2耦合(是/否)', 'P2审议率', 'P3余量', '驳回率', 'P2干预TV', '末存续', '耦合应用'];
console.log(`# M4 附带代价（seeds=${SEEDS.join(',')} ticks=${TICKS} τ=${PARAMS.coupling.tau} minInput=${PARAMS.coupling.minInput} 组名=${GROUP}）`);
console.log('| 判据读数 | coupling 关 | coupling 开 | 变化 |');
console.log('|---|---|---|---|');
for (const k of KEYS) console.log(`| ${k} | ${off[k]} | ${on[k]} | ${typeof off[k] === 'number' && typeof on[k] === 'number' ? Number((on[k] - off[k]).toFixed(3)) : '—'} |`);
console.log('\n行动来源（需求主导分布，5 seed 均值）');
console.log('| 来源 | 关 | 开 |');
console.log('|---|---|---|');
for (const k of new Set([...Object.keys(off.行动来源), ...Object.keys(on.行动来源)])) console.log(`| ${k} | ${off.行动来源[k] ?? 0} | ${on.行动来源[k] ?? 0} |`);
console.log('\n明细（每 seed）');
console.table(off.明细.map((r, i) => ({ seed: SEEDS[i], 关: r, 开: on.明细[i] })));
console.log(`\n切断负控：两档的 P2切断TV 都为 0（assertCutNegative 已在每档每 seed 实际执行，未通过即抛错）`);

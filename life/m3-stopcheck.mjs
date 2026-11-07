// M3 停止检验（预登记 2026-11-07）：真实轨迹上，"最多 20 条、每条至多 3 个原子条件"的受限规则表
// 能否在**独立 seed、且严格更晚的窗口**上复现 M3 的功能状态选择。
//
// 判据（跑之前写死）：
//   触发停损 = 留出准确率 ≥ 0.95 且 ≥ 众数基线 + 0.15；
//   若众数基线 ≥ 0.90，判据本身区分力不足，必须单独报告，不能当"通过"；
//   标签置乱后的留出准确率必须 ≤ 众数基线 + 0.05，否则说明特征里有泄漏。
// 侧限（照 m3-benchmark 的口径）：贪心搜索不保证完备，未触发不等于"不存在这样的 20 条程序"。
import { simulate } from './run.mjs';
import { BehaviorState, BEHAVIOR_STATES } from './m3-state.mjs';
import { OLD_FEATURES, oldSelectorWitness, evaluateHeldout, scoreRuleList } from './m3-benchmark.mjs';

const GOALS = ['recover', 'connect', 'explore', 'maintain'];
const level = (v) => (v < 0.33 ? 'low' : v < 0.66 ? 'mid' : 'high');
const NEEDS = ['energy', 'social', 'stimulation'];
const MODS = ['arousal', 'approach', 'inhibit', 'quiescence'];

// 正控：第一候选（四信号）在 1440 个组合上必须被那 7 条显式规则精确重放。
// 这一步不过，后面所有"新候选被规则复现"的读数都没有意义——那只能说明复现器自己不准。
export function oldWitnessControl() {
  const rows = [];
  for (const previous of [null, ...BEHAVIOR_STATES]) {
    for (const remaining of [0, 1, 3]) {
      for (const energy of [0, 0.2, 1, 5]) {
        for (const social of [0, 0.2, 1, 5]) {
          for (const stimulus of [0, 0.5, 2]) {
            for (const risk of [0, 0.6]) {
              const m = new BehaviorState();
              m.load({ state: previous, remaining });
              const before = m.dump();
              const drives = { errors: () => [{ name: 'energy', urgency: energy }, { name: 'social', urgency: social }, { name: 'stimulation', urgency: stimulus, dir: 1 }] };
              const bank = { m: { approach: 0.4, quiescence: 0.6, inhibit: 0.3, arousal: 0.5 } };
              const r = m.step({ drives, bank, risk, commitment: 4 });
              rows.push({ seed: 0, t: rows.length, x: { previous: before.state, remaining: before.remaining, ...r.signals }, y: r.state });
            }
          }
        }
      }
    }
  }
  return scoreRuleList(oldSelectorWitness(), rows, OLD_FEATURES);
}

export function predicates() {
  const ps = [];
  for (const g of [null, ...GOALS]) ps.push({ left: 'previous', op: 'eq', value: g });
  for (const p of [{ op: 'gt', value: 0 }, { op: 'le', value: 0 }, { op: 'ge', value: 1 }, { op: 'le', value: 1 }, { op: 'ge', value: 2 }, { op: 'le', value: 2 }]) ps.push({ left: 'remaining', ...p });
  for (const f of [...NEEDS, ...MODS]) for (const l of ['low', 'mid', 'high']) ps.push({ left: f, op: 'eq', value: l });
  return ps;
}

export async function collect({ seeds = [7, 11, 13, 23, 42], ticks = 1200 } = {}) {
  const rows = [];
  for (const seed of seeds) {
    const { agents } = await simulate({ seed, ticks, condition: 'C2', channelMask: { m3: 1 } });
    for (const a of Object.values(agents)) {
      for (const r of a.trace) {
        if (!r.m3 || !r.action) continue; // 只统计"真的做过非反射选择"的样本（预登记）
        const x = { previous: r.m3.previous, remaining: r.m3.remaining };
        for (const n of NEEDS) x[n] = level(r.drives?.[n] ?? 0);
        for (const m of MODS) x[m] = level(r.m?.[m] ?? 0);
        rows.push({ seed, t: r.t, id: a.id, x, y: r.m3.goal });
      }
    }
  }
  return rows;
}

const distOf = (rows) => Object.fromEntries(GOALS.map((g) => [g, rows.filter((r) => r.y === g).length]));
const majorityAcc = (rows) => {
  const c = distOf(rows);
  const n = rows.length || 1;
  return Math.max(...Object.values(c)) / n;
};

export async function stopCheck({ ticks = 1200 } = {}) {
  const control = oldWitnessControl();
  const rows = await collect({ ticks });
  const train = rows.filter((r) => r.seed !== 23 && r.seed !== 42 && r.t <= 600);
  const test = rows.filter((r) => (r.seed === 23 || r.seed === 42) && r.t >= 601);
  const ps = predicates();
  const held = evaluateHeldout(train, test, { allowedFeatures: ['previous', 'remaining', ...NEEDS, ...MODS], predicates: ps, maxRules: 20 });
  const base = majorityAcc(test);
  // 标签置乱负控：保住特征、打乱目标。如果这样也能高分，说明"复现"只是特征里带着答案
  const shuffled = train.map((r, i) => ({ ...r, y: train[(i * 7919 + 13) % train.length].y }));
  const sh = evaluateHeldout(shuffled, test, { allowedFeatures: ['previous', 'remaining', ...NEEDS, ...MODS], predicates: ps, maxRules: 20 });
  return {
    control: { n: control.n, accuracy: control.accuracy },
    rows: { total: rows.length, train: train.length, test: test.length },
    goalDist: { train: distOf(train), test: distOf(test) },
    baseline: Number(base.toFixed(4)),
    train: Number(held.train.accuracy.toFixed(4)),
    test: Number(held.test.accuracy.toFixed(4)),
    rules: held.model.rules.length,
    byClass: Object.fromEntries(Object.entries(held.test.byClass).map(([k, v]) => [k, { n: v.n, acc: Number((v.correct / (v.n || 1)).toFixed(3)) }])),
    shuffledTest: Number(sh.test.accuracy.toFixed(4)),
    verdict: base >= 0.9 ? '判据区分力不足（众数基线≥0.90）' : held.test.accuracy >= 0.95 && held.test.accuracy >= base + 0.15 ? '触发停损：可被受限规则族脚本化' : '未触发',
  };
}

if (process.argv[1]?.endsWith('m3-stopcheck.mjs')) {
  const out = await stopCheck();
  console.log(JSON.stringify(out, null, 2));
}

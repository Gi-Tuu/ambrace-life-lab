// §24 供给常数取舍表（只测量，不改默认值、不改引擎）。阈值半引用 §40 B，不重跑。
// 自变量 = simulate 的 pantry/stash 初始供给（已在冻结指纹 supply= 里）；每档 ⑥ 开/关两臂给 KL 净效应。
// 读数与 §40 B 同定义：recoveryStats 的 drops / tailSlopePer100；越轨用 counters.normbreak 合计。
// 用法：node life/supply-tradeoff-sweep.mjs > docs/evidence/const-20261108/supply-tradeoff.log
import { PARAMS } from './params.mjs';
import { simulate } from './run.mjs';
import { dist, kl, recoveryStats } from './metrics.mjs';

const PANTRY = [0, 3, 6, 8];
const STASH = [0, 3, 5];
const SEEDS = [7, 11, 13];
const r3 = (x) => Number(x.toFixed(3));
const seriesOf = (a) => a.trace
  .filter((x) => x.viab)
  .map((x) => ({ t: x.t, v: x.viab.v, reserve: x.viab.reserve ?? 0, ledger: x.viab.ledger, ate: (x.viab.ate ?? 0) >= PARAMS.viab.mealMin }));
const actionsOf = (agents) => Object.values(agents).flatMap((a) => a.trace.filter((x) => x.action).map((x) => x.action));

const rows = [];
for (const pantry of PANTRY) {
  for (const stash of STASH) {
    let drops = 0, endV = 0, negTail = 0, dropped = 0, n = 0, klSum = 0, normbreak = 0;
    for (const seed of SEEDS) {
      const on = await simulate({ seed, ticks: 1200, condition: 'C2', pantry, stash, group: `供给p${ pantry }s${ stash }-开` });
      const off = await simulate({ seed, ticks: 1200, condition: 'C2', channelMask: { erosion: 0 }, pantry, stash, group: `供给p${ pantry }s${ stash }-关` });
      klSum += kl(dist(actionsOf(on.agents)), dist(actionsOf(off.agents)));
      for (const a of Object.values(on.agents)) {
        normbreak += a.counters.normbreak ?? 0;
        const st = recoveryStats(seriesOf(a), { crit: PARAMS.viab.crit });
        if (!st || !st.samples) continue;
        n++;
        drops += st.drops;
        endV += st.endV;
        if (st.drops > 0) {
          dropped++;
          if (st.tailSlopePer100 < 0) negTail++;
        }
      }
    }
    rows.push({
      pantry, stash,
      掉档总数: drops,
      垮过的样本: `${dropped}/${n}`,
      末段仍跌: `${negTail}/${dropped || 0}`,
      末v: r3(endV / Math.max(1, n)),
      '⑥净效应KL': r3(klSum / SEEDS.length),
      越轨: normbreak,
    });
  }
}
console.table(rows);
console.log('协议', JSON.stringify({ seeds: SEEDS, ticks: 1200, crit: PARAMS.viab.crit, 阈值: PARAMS.viab.thresholds, 默认供给: [6, 3] }));

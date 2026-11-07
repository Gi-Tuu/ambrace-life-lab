// §40 B 的取舍表：侵蚀阈值往下挪，"垮"会变少，但 ⑥ 的证据也会跟着变少。
// 这里同时跑两条臂（⑥ 开 / ⑥ 关），把"掉档总数"和"⑥ 的行为净效应（动作分布 KL）"放在一起报，
// 因为这两个数是同一个事件的两侧：没有人掉档，就没有东西可切。
// 阈值与 crit 属于实验自变量，按 params.mjs 的规矩不进冻结指纹；每个变体自带组名。
import { PARAMS } from './params.mjs';
import { simulate } from './run.mjs';
import { dist, kl, recoveryStats } from './metrics.mjs';

const VARIANTS = [
  { 名: 'T0 现状', th: [0.5, 0.32, 0.15] },
  { 名: 'T1', th: [0.4, 0.25, 0.12] },
  { 名: 'T2', th: [0.35, 0.22, 0.1] },
  { 名: 'T3', th: [0.3, 0.18, 0.08] },
];
const SEEDS = [7, 11, 13];
const CONFIGS = [
  { 配置: '常态', pantry: 6, stash: 3 },
  { 配置: '低补给', pantry: 0, stash: 0 },
  { 配置: '宽裕', pantry: 8, stash: 5 },
];
const r3 = (x) => Number(x.toFixed(3));
const seriesOf = (a) => a.trace
  .filter((x) => x.viab)
  .map((x) => ({ t: x.t, v: x.viab.v, reserve: x.viab.reserve ?? 0, ledger: x.viab.ledger, ate: (x.viab.ate ?? 0) >= PARAMS.viab.mealMin }));
const actionsOf = (agents) => Object.values(agents).flatMap((a) => a.trace.filter((x) => x.action).map((x) => x.action));

const rows = [];
for (const v of VARIANTS) {
  PARAMS.viab.thresholds = v.th;
  for (const c of CONFIGS) {
    let drops = 0, endV = 0, negTail = 0, dropped = 0, n = 0, riskOn = 0, meals = 0, span = 0;
    let klSum = 0;
    for (const seed of SEEDS) {
      const on = await simulate({ seed, ticks: 1200, condition: 'C2', pantry: c.pantry, stash: c.stash, group: `${v.名}-${c.配置}-开` });
      // ⑥ 关：存续照样演化，但不削部件（唯一切断点在 damage 上，见 viability.mjs 注释）
      const off = await simulate({ seed, ticks: 1200, condition: 'C2', channelMask: { erosion: 0 }, pantry: c.pantry, stash: c.stash, group: `${v.名}-${c.配置}-关` });
      klSum += kl(dist(actionsOf(on.agents)), dist(actionsOf(off.agents)));
      for (const a of Object.values(on.agents)) {
        const st = recoveryStats(seriesOf(a), { crit: PARAMS.viab.crit });
        if (!st || !st.samples) continue;
        n++;
        drops += st.drops;
        endV += st.endV;
        meals += st.samples ? seriesOf(a).filter((x) => x.ate).length : 0;
        span += st.samples;
        riskOn += a.trace.filter((x) => x.viab && x.viab.risk > 0).length / Math.max(1, a.trace.filter((x) => x.viab).length);
        if (st.drops > 0) {
          dropped++;
          if (st.tailSlopePer100 < 0) negTail++;
        }
      }
    }
    rows.push({
      阈值: v.名,
      配置: c.配置,
      掉档总数: drops,
      垮过的样本: `${dropped}/${n}`,
      末段仍跌: `${negTail}/${dropped || 0}`,
      末v: r3(endV / n),
      风险开启占比: r3(riskOn / n),
      '⑥净效应KL': r3(klSum / SEEDS.length),
      部件侵蚀事件: drops,
    });
  }
}
PARAMS.viab.thresholds = [0.5, 0.32, 0.15];
console.table(rows);
console.log('协议', JSON.stringify({ seeds: SEEDS, ticks: 1200, crit: PARAMS.viab.crit, 默认阈值: [0.5, 0.32, 0.15] }));

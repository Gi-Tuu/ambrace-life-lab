// §39 定档扫描：餐后扣存比例 spill 扫六档，看"不可逆损伤"往哪边走、代价落在谁身上。
// 判据是跑之前预登记的（低补给掉档下降 + 垮过样本末段不再全为负；常态侧 P1a/驳回恶化 ≤10%；取最小达标档）。
// 全部离线，未打网络。spill 直接改 PARAMS，所以每个档位用带 spill 前缀的组名，冻结校验照样管得住。
import { PARAMS } from './params.mjs';
import { simulate, p1a } from './run.mjs';
import { recoveryStats, driverDist } from './metrics.mjs';

const SPILLS = [0, 0.1, 0.2, 0.3, 0.5, 0.7];
const SEEDS = [7, 11, 13];
const CONFIGS = [
  { 配置: '常态', pantry: 6, stash: 3 },
  { 配置: '低补给', pantry: 0, stash: 0 },
  { 配置: '宽裕', pantry: 8, stash: 5 },
];
const seriesOf = (a) => a.trace
  .filter((r) => r.viab)
  .map((r) => ({ t: r.t, v: r.viab.v, reserve: r.viab.reserve ?? 0, ledger: r.viab.ledger, ate: Boolean(r.ok) && (r.kind === 'eat' || r.kind === 'take_shared') }));
const r3 = (x) => Number(x.toFixed(3));

const rows = [];
for (const spill of SPILLS) {
  PARAMS.viab.spill = spill;
  const out = { spill };
  for (const c of CONFIGS) {
    let n = 0, drops = 0, dropped = 0, negTail = 0, endV = 0, trough = 0, reserveShare = 0, meals = 0, critShare = 0;
    for (const seed of SEEDS) {
      const { agents } = await simulate({ seed, ticks: 1200, condition: 'C2', pantry: c.pantry, stash: c.stash, group: `spill${spill}-${c.配置}` });
      for (const a of Object.values(agents)) {
        const s = seriesOf(a);
        const st = recoveryStats(s, { crit: PARAMS.viab.crit });
        if (!st || !st.samples) continue;
        n++;
        drops += st.drops;
        endV += st.endV;
        reserveShare += st.reserveShare;
        meals += st.meals;
        trough += Math.min(...s.map((x) => x.v));
        critShare += s.filter((x) => x.v >= PARAMS.viab.crit).length / s.length;
        if (st.drops > 0) {
          dropped++;
          if (st.tailSlopePer100 < 0) negTail++;
        }
      }
    }
    const k = c.配置;
    out[`${k}掉档`] = drops;
    out[`${k}垮过人`] = `${dropped}/${n}`;
    out[`${k}末段仍跌`] = `${negTail}/${dropped || 0}`;
    out[`${k}谷底v`] = r3(trough / n);
    out[`${k}末v`] = r3(endV / n);
    out[`${k}操作点时长`] = r3(critShare / n);
    out[`${k}储能时长`] = r3(reserveShare / n);
    out[`${k}取食每百刻`] = r3((meals / n / 12));
  }
  // 代价侧：常态世界的行为读数不能因为代谢改动被洗掉，否则"承重"那条证据就换了出处
  const { agents } = await simulate({ seed: 7, ticks: 400, condition: 'C2', group: `spill${spill}-代价` });
  const d = driverDist(Object.values(agents).flatMap((a) => a.trace));
  const one = await p1a({ seed: 7, ticks: 320, condition: 'C2', group: `spill${spill}-代价` });
  out.驳回 = Object.values(agents).reduce((s, a) => s + a.counters.rejected, 0);
  out.需求主导 = r3(['energy', 'social', 'stimulation'].reduce((s, k) => s + (d[k] ?? 0), 0));
  out['P1a KL'] = one.meanKl;
  rows.push(out);
}
PARAMS.viab.spill = 0;
console.table(rows);
console.log('协议', JSON.stringify({ spills: SPILLS, seeds: SEEDS, ticks: 1200, crit: PARAMS.viab.crit, reserveMax: PARAMS.viab.reserveMax, refill: PARAMS.viab.refill, upkeep: PARAMS.viab.upkeep }));

// V7.2 F1：四组策略（无干预 / 消费型 / 生产型 / 自主居民对照），正式游戏。
// 自然演化 vs 干预在每行显式标注；玩家死亡后聚落统计继续（independentWorld）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay, survAct } from './survplay.mjs';
import { livingResidents } from './viability.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { ledgerStats } from './action-ledger.mjs';
import { RESIDENT_MIN as RES_MIN, LABOR_ENERGY } from './resident-time.mjs';
const LABOR = new Set(Object.keys(LABOR_ENERGY).filter((k) => LABOR_ENERGY[k] > 0));
import { move } from './body.mjs';
import { resLedgerView } from './resource-ledger.mjs';

const DAY = 24;
export const STRATEGY_SEEDS = [7, 13, 29];

const STRATEGIES = {
  natural: { intervention: '无干预（玩家闲置、不占配给）', options: { playerRation: false } },
  consumer: { intervention: '消费型（玩家每天占一份配给，不生产）', options: { playerRation: true } },
  producer: { intervention: '生产型（玩家每天采集 2 次并入公仓，占一份配给）', options: { playerRation: true }, policy: 'produce' },
  autonomous: { intervention: '自主居民对照（玩家开局死亡，居民自主）', options: { playerRation: false }, policy: 'playerDead' },
};

async function runOne(name, seed, days) {
  const cfg = STRATEGIES[name];
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, ...cfg.options });
  const w = sp.world;
  let marriageEvents = 0;
  w.observeFamilyMarriage = () => { marriageEvents += 1; };
  if (cfg.policy === 'playerDead') { w.agents.p1.dead = true; w.agents.p1.viab.v = 0; }
  for (let d = 0; d < days; d += 1) {
    if (cfg.policy === 'produce' && !w.agents.p1.dead) {
      // 每日一次生产：走到院子采集两次，回仓入库
      move(w, 'p1', 'yard');
      await survAct(sp, { kind: 'gather' });
      await survAct(sp, { kind: 'gather' });
      move(w, 'p1', 'store');
      await survAct(sp, { kind: 'deposit', type: 'wood' });
    }
    for (let i = 0; i < DAY; i += 1) await tickSurvPlay(sp);
    if (w.survival.ended) break;
  }
  const res = resLedgerView(w);
  // 劳动占比：与 long-run 同一口径（aiActions × 动作分钟表），不新增模拟路径。
  let labor = 0, totalMinutes = 0;
  for (const [kind, n] of Object.entries(w.survival.aiActions ?? {})) {
    const mins = RES_MIN[kind] ?? 10;
    totalMinutes += n * mins;
    if (LABOR.has(kind)) labor += n * mins;
  }
  return {
    strategy: name, intervention: cfg.intervention, seed, days,
    playerAlive: !(w.agents.p1?.dead),
    population: livingResidents(w).length,
    births: w.survival.births ?? 0,
    marriages: marriageEvents,
    marriedPairs: (() => { const seen = new Set(); let n = 0; for (const [id, sp2] of Object.entries(w.survival.households?.spouses ?? {})) { if (!sp2) continue; const k = [id, sp2].sort().join('|'); if (!seen.has(k)) { seen.add(k); n += 1; } } return n; })(),
    deaths: (w.survival.deaths ?? []).length,
    ended: !!w.survival.ended,
    store: w.survival.store,
    consumed: res?.totals?.consumed ?? null,
    laborMinutes: labor,
    laborShare: totalMinutes ? Number((labor / totalMinutes).toFixed(4)) : null,
  };
}

export async function measureStrategies(tag = 'run', daysList = [30, 100, 200]) {
  const rows = [];
  for (const days of daysList) for (const name of Object.keys(STRATEGIES)) for (const seed of STRATEGY_SEEDS) {
    rows.push(await runOne(name, seed, days));
  }
  const out = { tag, generatedAt: new Date().toISOString(), daysList, seeds: STRATEGY_SEEDS, strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.intervention])), rows };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/strategies-${tag}.json`, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1]?.endsWith('strategy-probe.mjs')) {
  const out = await measureStrategies(process.argv[2] ?? 'run');
  for (const r of out.rows) console.log(JSON.stringify(r));
}







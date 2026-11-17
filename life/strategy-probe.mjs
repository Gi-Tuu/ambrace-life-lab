// V7.2 F1：四组策略（无干预 / 消费型 / 生产型 / 自主居民对照），正式游戏。
// 自然演化 vs 干预在每行显式标注；玩家死亡后聚落统计继续（independentWorld）。
import { writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay, survAct } from './survplay.mjs';
import { livingResidents } from './viability.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { ledgerStats } from './action-ledger.mjs';
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
  if (cfg.policy === 'playerDead') { w.agents.p1.dead = true; w.agents.p1.viab.v = 0; }
  const endedP1 = cfg.policy === 'playerDead';
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
  return {
    strategy: name, intervention: cfg.intervention, seed, days,
    playerDead: Boolean(w.agents.p1?.dead) || endedP1,
    population: livingResidents(w).length,
    births: w.survival.births ?? 0,
    deaths: (w.survival.deaths ?? []).length,
    ended: !!w.survival.ended,
    store: w.survival.store,
    consumed: res?.totals?.consumed ?? null,
    laborMinutes: ledgerStats(w)?.resident?.minutes ?? null,
  };
}

export async function measureStrategies(tag = 'run', daysList = [30, 100]) {
  const rows = [];
  for (const days of daysList) for (const name of Object.keys(STRATEGIES)) for (const seed of STRATEGY_SEEDS) {
    rows.push(await runOne(name, seed, days));
  }
  const out = { tag, generatedAt: new Date().toISOString(), daysList, seeds: STRATEGY_SEEDS, strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.intervention])), rows };
  writeFileSync(`docs/strategies-${tag}.json`, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1]?.endsWith('strategy-probe.mjs')) {
  const out = await measureStrategies(process.argv[2] ?? 'run', [30, 100]);
  for (const r of out.rows) console.log(JSON.stringify(r));
}


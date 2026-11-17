// V7.2 D3/D4：正式游戏长期农业与消费表（30/100/200 日，5 种子）。
// 只读模拟，不改规则；产物 docs/agri-<tag>.json。
import { writeFileSync } from 'node:fs';
import { runLong, LONG_SEEDS } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';

export async function agriMeasure(tag = 'run', daysList = [30, 100, 200]) {
  const rows = [];
  for (const days of daysList) {
    for (const seed of LONG_SEEDS) {
      const r = await runLong(seed, days, { checkpoints: [days], options: FORMAL_OPTIONS });
      rows.push({
        days, seed,
        population: r.final.population, births: r.final.births, ended: r.final.ended,
        store: r.final.store, storeCap: r.final.agri?.storeCap,
        plots: r.final.agri?.plots, mature: r.final.agri?.mature, growing: r.final.agri?.growing,
        yieldTotal: r.final.agri?.yieldTotal, harvestCount: r.final.agri?.harvestCount,
        water: r.final.agri?.water, soil: r.final.agri?.soil,
        droughtDays: r.daily?.last?.filter?.((d) => d.drought)?.length ?? null,
        disasterDays: r.daily?.disasterDays ?? null,
        produce: r.final.agri?.produce, livestock: r.final.agri?.livestock,
        consumed: r.final.resources?.totals?.consumed ?? 0,
        gross: r.final.resources?.totals?.gross ?? null,
        publicIn: r.final.resources?.totals?.publicIn ?? null,
        overflow: r.final.resources?.totals?.overflow ?? null,
        personal: r.final.resources?.totals?.personal ?? null,
        laborMinutes: r.final.laborMinutes,
      });
    }
  }
  const summarize = (days) => {
    const rs = rows.filter((r) => r.days === days);
    const sum = (k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
    return {
      days,
      avgPopulation: Number((sum('population') / rs.length).toFixed(2)),
      births: sum('births'), extinct: rs.filter((r) => r.ended).length,
      yieldTotal: sum('yieldTotal'), harvestCount: sum('harvestCount'),
      publicIn: sum('publicIn'), overflow: sum('overflow'), personal: sum('personal'), consumed: sum('consumed'),
      avgWater: Number((sum('water') / rs.length).toFixed(2)), avgSoil: Number((sum('soil') / rs.length).toFixed(2)),
      avgStore: Number((sum('store') / rs.length).toFixed(1)),
    };
  };
  const summary = daysList.map(summarize);
  const out = { tag, generatedAt: new Date().toISOString(), seeds: LONG_SEEDS, rows, summary };
  writeFileSync(`docs/agri-${tag}.json`, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1]?.endsWith('agri-probe.mjs')) {
  const tag = process.argv[2] ?? 'run';
  const out = await agriMeasure(tag);
  console.log(JSON.stringify(out.summary, null, 2));
}


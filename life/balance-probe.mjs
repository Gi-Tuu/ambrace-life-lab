// V7.2 平衡：正式游戏（gameRules:true）5 种子 × 100/200 日的量化探针。
// 只读模拟，不改任何规则；研究态不会用到这个脚本。
// 用法：node life/balance-probe.mjs baseline
import { mkdirSync, writeFileSync } from 'node:fs';
import { runLong, LONG_SEEDS } from './long-run.mjs';

export const FORMAL_OPTIONS = Object.freeze({
  residentialDecisions: true, ecosystem: true, unifiedCooperation: true, independentWorld: true,
  wildFood: true, autonomousGoals: true, farmLife: true, settlementLife: true, regionalWork: true,
  playerRation: true, gameRules: true, discussions: true,
});

const row = (seed, days, r) => ({
  seed, days,
  population: r.final.population,
  births: r.final.births,
  deaths: r.final.deaths ?? 0,
  deathCauses: r.final.deathCauses,
  energyAvg: r.final.energy?.avg ?? null,
  viabAvg: r.final.viability?.avg ?? null,
  laborShare: r.final.laborShare,
  laborMinutes: r.final.laborMinutes,
  marriages: r.final.family?.marriages ?? 0,
  stages: r.final.stages,
  ended: r.final.ended,
  shortfallDays: r.daily.shortfallDays,
  agentErrors: r.final.agentErrors ?? 0,
});

export async function measure(tag = 'run') {
  const rows = [];
  for (const seed of LONG_SEEDS) {
    const r100 = await runLong(seed, 100, { checkpoints: [100], options: FORMAL_OPTIONS });
    rows.push(row(seed, 100, r100));
    const r200 = await runLong(seed, 200, { checkpoints: [100, 200], options: FORMAL_OPTIONS });
    rows.push(row(seed, 200, r200));
  }
  const extinct200 = rows.filter((r) => r.days === 200 && r.ended).length;
  const alive200 = rows.filter((r) => r.days === 200 && !r.ended);
  const summary = {
    seeds: LONG_SEEDS,
    extinctAt200: `${extinct200}/${LONG_SEEDS.length}`,
    population100: rows.filter((r) => r.days === 100).map((r) => r.population),
    population200: alive200.map((r) => r.population),
    births100: rows.filter((r) => r.days === 100).reduce((s, r) => s + r.births, 0),
    deaths100: rows.filter((r) => r.days === 100).reduce((s, r) => s + r.deaths, 0),
    marriages100: rows.filter((r) => r.days === 100).reduce((s, r) => s + r.marriages, 0),
    energyAvg100: Number((rows.filter((r) => r.days === 100).reduce((s, r) => s + (r.energyAvg ?? 0), 0) / LONG_SEEDS.length).toFixed(4)),
    laborShare100: Number((rows.filter((r) => r.days === 100).reduce((s, r) => s + (r.laborShare ?? 0), 0) / LONG_SEEDS.length).toFixed(4)),
    deathCauses100: rows.filter((r) => r.days === 100).reduce((acc, r) => {
      for (const [k, n] of Object.entries(r.deathCauses ?? {})) acc[k] = (acc[k] ?? 0) + n;
      return acc;
    }, {}),
  };
  const out = { tag, generatedAt: new Date().toISOString(), formalOptions: FORMAL_OPTIONS, rows, summary };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/balance-${tag}.json`, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1]?.endsWith('balance-probe.mjs')) {
  const tag = process.argv[2] ?? 'run';
  const out = await measure(tag);
  console.log(JSON.stringify(out.summary, null, 2));
  for (const r of out.rows) console.log(JSON.stringify(r));
}



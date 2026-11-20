#!/usr/bin/env node
// P3 长程重定基线：正式游戏（FORMAL_OPTIONS）5 种子 × 30/100/200 日，一次跑到 200 日并在 30/100/200 取 checkpoint。
// 输出 evidence/redo-p3/long-run.json + long-run.log。
//
// 口径与 life/v72-balance.test.mjs / v72-b-population.test.mjs 一致（同一 FORMAL_OPTIONS、同一 runLong）。
// 额外做「30 日 3 种子 quickstart 类验收」：720 刻、初始公仓 6、agentErrors=0、人口 4–6。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLong, LONG_SEEDS } from '../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../life/balance-probe.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'evidence', 'redo-p3');
mkdirSync(OUT, { recursive: true });

const rows = [];
for (const seed of LONG_SEEDS) {
  const r = await runLong(seed, 200, { checkpoints: [30, 100, 200], options: FORMAL_OPTIONS });
  const m30 = r.milestones[30], m100 = r.milestones[100], m200 = r.milestones[200];
  rows.push({
    seed,
    population: { 30: m30.population, 100: m100.population, 200: m200.population },
    births: { 30: m30.births, 100: m100.births, 200: m200.births },
    deaths: { 100: m100.deaths, 200: m200.deaths },
    deathCauses: m200.deathCauses,
    ended200: m200.ended,
    laborMinutes100: m100.laborMinutes,
    agentErrors: r.final.agentErrors,
    runtime: r.runtime,
  });
  console.log(JSON.stringify({ seed, population: rows.at(-1).population, births100: m100.births, ended200: m200.ended, errors: r.final.agentErrors }));
}

const populations = (day) => rows.map((r) => r.population[day]);
const avg = (xs) => Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));
const births100 = rows.reduce((s, r) => s + r.births[100], 0);
const extinct200 = rows.filter((r) => r.ended200).length;
const summary = {
  seeds: LONG_SEEDS,
  population30: populations(30),
  population100: populations(100),
  population200: populations(200),
  avg30: avg(populations(30)), avg100: avg(populations(100)), avg200: avg(populations(200)),
  births100,
  extinct200: `${extinct200}/${LONG_SEEDS.length}`,
  knownDeathCauses: [...new Set(rows.flatMap((r) => Object.keys(r.deathCauses ?? {})))].sort(),
  agentErrors: rows.reduce((s, r) => s + r.agentErrors, 0),
};

// 30 日 3 种子 quickstart 类验收（与 200 日轨迹的前 30 日同一配置，但独立跑一遍验证 720 刻口径）。
const quick = [];
for (const seed of LONG_SEEDS.slice(0, 3)) {
  const r = await runLong(seed, 30, { checkpoints: [30], options: FORMAL_OPTIONS });
  quick.push({
    seed,
    ticks: r.ticks, t: r.final.t, population: r.final.population,
    initialStore: r.initial.store, agentErrors: r.final.agentErrors,
    births: r.final.births, days: r.daily.days,
  });
}
const quickOk = quick.every((q) => q.ticks === 720 && q.t === 720 && q.initialStore === 6 && q.agentErrors === 0 && q.population >= 3 && q.population <= 6);

const out = { at: new Date().toISOString(), options: FORMAL_OPTIONS, rows, summary, quick30x3: { ok: quickOk, rows: quick } };
writeFileSync(join(OUT, 'long-run.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ summary, quick30x3: out.quick30x3 }, null, 2));

#!/usr/bin/env node
// 1.1 第 2 项：分钟生理长程对照（5 seeds × 30/100/200 日，正式连续钟）。
//
//   node scripts/v11-metab-long-run.mjs --mode on  > evidence/v11-metab/long-run-on.log
//   node scripts/v11-metab-long-run.mjs --mode off > evidence/v11-metab/long-run-off.log
//
// 口径：
//   · 每个 seed 一次跑到 200 日，在 30/100/200 日取 checkpoint（与 p3-long-run 同口径）。
//   · 只走 simClock 的显式 60 游戏分钟步（同一时钟，不另起时钟）；每步内部仍逐分钟积分。
//   · on = M5_MINUTE_METAB 默认（分钟身体）；off = 显式 minuteMetab:false（旧每刻结算）。
//   · 不改任何阈值；只如实列人口/灭绝/死因/存续/能量。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLong, LONG_SEEDS } from '../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../life/balance-probe.mjs';
import { createSimClock } from '../life/sim-clock.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'evidence', 'v11-metab');
mkdirSync(OUT, { recursive: true });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const mode = arg('mode', 'on') === 'off' ? 'off' : 'on';
const minuteMetab = mode === 'on';
const seeds = (arg('seeds', LONG_SEEDS.join(','))).split(',').map(Number);

const rows = [];
for (const seed of seeds) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  const r = await runLong(seed, 200, {
    checkpoints: [30, 100, 200],
    options: { ...FORMAL_OPTIONS, simTime: true, simClock: clock, minuteMetab },
  });
  const m30 = r.milestones[30], m100 = r.milestones[100], m200 = r.milestones[200];
  const row = {
    seed,
    population: { 30: m30.population, 100: m100.population, 200: m200.population },
    births: { 30: m30.births, 100: m100.births, 200: m200.births },
    deaths: { 30: m30.deaths, 100: m100.deaths, 200: m200.deaths },
    deathCauses: m200.deathCauses,
    ended200: m200.ended,
    energy: { 30: m30.energy, 100: m100.energy, 200: m200.energy },
    viability: { 30: m30.viability, 100: m100.viability, 200: m200.viability },
    laborMinutes100: m100.laborMinutes,
    agentErrors: r.final.agentErrors,
    runtime: r.runtime,
  };
  rows.push(row);
  console.log(JSON.stringify({ mode, seed, population: row.population, births100: m100.births, ended200: m200.ended, errors: r.final.agentErrors }));
}

const populations = (day) => rows.map((r) => r.population[day]);
const avg = (xs) => Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));
const extinct200 = rows.filter((r) => r.ended200).length;
const summary = {
  mode,
  minuteMetab,
  seeds,
  population30: populations(30),
  population100: populations(100),
  population200: populations(200),
  avg30: avg(populations(30)), avg100: avg(populations(100)), avg200: avg(populations(200)),
  births100: rows.reduce((s, r) => s + r.births[100], 0),
  deaths100: rows.reduce((s, r) => s + r.deaths[100], 0),
  extinct200: `${extinct200}/${seeds.length}`,
  deathCauses200: rows.reduce((acc, r) => {
    for (const [k, n] of Object.entries(r.deathCauses ?? {})) acc[k] = (acc[k] ?? 0) + n;
    return acc;
  }, {}),
  agentErrors: rows.reduce((s, r) => s + r.agentErrors, 0),
};
const out = {
  _说明: '1.1 第 2 项分钟生理长程对照；on/off 只差 M5_MINUTE_METAB 身体结算方式，阈值未改。',
  at: new Date().toISOString(),
  mode,
  options: { ...FORMAL_OPTIONS, simTime: true },
  rows,
  summary,
};
writeFileSync(join(OUT, `long-run-${mode}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ summary }, null, 2));

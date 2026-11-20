#!/usr/bin/env node
// 1.1 正式钟生存闸门：5 seeds × 30/100/200 日，四种口径同脚本。
//
//   node scripts/v11-balance-long-run.mjs --mode on            > evidence/v11-balance/long-run-on.log
//   node scripts/v11-balance-long-run.mjs --mode off           > evidence/v11-balance/long-run-off.log
//   node scripts/v11-balance-long-run.mjs --mode legacy-formal > evidence/v11-balance/long-run-legacy-formal.log
//   node scripts/v11-balance-long-run.mjs --mode p3            > evidence/v11-balance/long-run-p3.log
//
// · on/off：正式连续钟（simTime+gameRules+simClock，60 游戏分/步）；off = M5_MINUTE_METAB=0 回退身体结算。
// · legacy-formal：同一 FORMAL_OPTIONS，但无 simClock（旧“每刻=1 小时”路径，作为对照）。
// · p3：P3 GAME_OPTIONS（gameRules=false、无 farmLife/settlementLife），即已发布的旧长程口径。
// 不改任何阈值；只如实记录人口/灭绝/死因/存续/能量/劳动分钟。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLong, LONG_SEEDS, GAME_OPTIONS } from '../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../life/balance-probe.mjs';
import { createSimClock } from '../life/sim-clock.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'evidence', 'v11-balance');
mkdirSync(OUT, { recursive: true });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const mode = arg('mode', 'on');
const rules = Number(arg('rules', 2)); // 1 = LEGACY_EVENT_RULES，2 = CURRENT_EVENT_RULES
const seeds = arg('seeds', LONG_SEEDS.join(',')).split(',').map(Number);
const days = Number(arg('days', 200));

const rows = [];
for (const seed of seeds) {
  const options = mode === 'p3' ? { ...GAME_OPTIONS, eventRulesVersion: rules } : { ...FORMAL_OPTIONS, eventRulesVersion: rules };
  if (mode === 'on' || mode === 'off') {
    const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
    options.simTime = true;
    options.simClock = clock;
    options.minuteMetab = mode === 'on';
  }
  const r = await runLong(seed, days, { checkpoints: [30, 100, 200].filter((d) => d <= days), options });
  const m = r.milestones;
  const row = {
    seed,
    population: { 30: m[30]?.population ?? null, 100: m[100]?.population ?? null, 200: m[200]?.population ?? null },
    births: { 30: m[30]?.births ?? null, 100: m[100]?.births ?? null, 200: m[200]?.births ?? null },
    deaths: { 30: m[30]?.deaths ?? null, 100: m[100]?.deaths ?? null, 200: m[200]?.deaths ?? null },
    deathCauses: m[200]?.deathCauses ?? m[100]?.deathCauses ?? {},
    ended: { 100: m[100]?.ended ?? null, 200: m[200]?.ended ?? null },
    energy: { 100: m[100]?.energy ?? null, 200: m[200]?.energy ?? null },
    viability: { 100: m[100]?.viability ?? null, 200: m[200]?.viability ?? null },
    laborMinutes100: m[100]?.laborMinutes ?? null,
    store: { 100: m[100]?.store ?? null, 200: m[200]?.store ?? null },
    runtime: r.runtime,
    agentErrors: r.final.agentErrors,
    curve: r.curve.filter((x) => x.day % 10 === 0).map((x) => [x.day, x.population, x.store]),
  };
  rows.push(row);
  console.log(JSON.stringify({ mode, seed, population: row.population, births100: m[100]?.births ?? null, ended200: row.ended[200], causes: row.deathCauses, errors: r.final.agentErrors }));
}

const pick = (day) => rows.map((r) => r.population[day]);
const avg = (xs) => Number((xs.filter((x) => x !== null).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((x) => x !== null).length)).toFixed(2));
const summary = {
  mode,
  seeds,
  days,
  population30: pick(30),
  population100: pick(100),
  population200: pick(200),
  avg30: avg(pick(30)), avg100: avg(pick(100)), avg200: avg(pick(200)),
  births100: rows.reduce((s, r) => s + (r.births[100] ?? 0), 0),
  deaths100: rows.reduce((s, r) => s + (r.deaths[100] ?? 0), 0),
  extinct100: `${rows.filter((r) => r.ended[100]).length}/${seeds.length}`,
  extinct200: `${rows.filter((r) => r.ended[200]).length}/${seeds.length}`,
  deathCauses200: rows.reduce((acc, r) => {
    for (const [k, n] of Object.entries(r.deathCauses ?? {})) acc[k] = (acc[k] ?? 0) + n;
    return acc;
  }, {}),
  agentErrors: rows.reduce((s, r) => s + r.agentErrors, 0),
};
const out = {
  _说明: '1.1 正式钟生存闸门：on/off/legacy-formal/p3 同脚本；不改阈值。',
  at: new Date().toISOString(),
  mode,
  options: { ...(mode === 'p3' ? GAME_OPTIONS : FORMAL_OPTIONS) },
  rows,
  summary,
};
writeFileSync(join(OUT, `long-run-${mode}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ summary }, null, 2));

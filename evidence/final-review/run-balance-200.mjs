// 独立审查用：在 caad92b 上重跑 5 seeds × 200 日正式钟，输出到 evidence/final-review/，
// 不覆盖 evidence/v11-balance 的既有台账。与 scripts/v11-balance-long-run.mjs 同口径，
// 额外记录 playerAlive / playerViab（原脚本没进 summary）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLong, LONG_SEEDS } from '../..//life/long-run.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';
import { createSimClock } from '../../life/sim-clock.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT = join(ROOT, 'evidence', 'final-review');
mkdirSync(OUT, { recursive: true });
const mode = process.argv.includes('--off') ? 'off' : 'on';
const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 200);

const rows = [];
for (const seed of LONG_SEEDS) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  const options = { ...FORMAL_OPTIONS, eventRulesVersion: 2, simTime: true, simClock: clock, minuteMetab: mode === 'on' };
  const r = await runLong(seed, days, { checkpoints: [30, 100, 200].filter((d) => d <= days), options });
  const m = r.milestones;
  rows.push({
    seed,
    population: { 30: m[30]?.population ?? null, 100: m[100]?.population ?? null, 200: m[200]?.population ?? null },
    births: { 100: m[100]?.births ?? null, 200: m[200]?.births ?? null },
    deaths: { 100: m[100]?.deaths ?? null, 200: m[200]?.deaths ?? null },
    deathCauses200: m[200]?.deathCauses ?? m[100]?.deathCauses ?? {},
    ended200: m[200]?.ended ?? null,
    playerAlive200: m[200]?.playerAlive ?? m[100]?.playerAlive ?? null,
    playerViab200: m[200]?.playerViab ?? m[100]?.playerViab ?? null,
    energy200: m[200]?.energy ?? null,
    viability200: m[200]?.viability ?? null,
    store200: m[200]?.store ?? null,
    laborMinutes100: m[100]?.laborMinutes ?? null,
    runtime: r.runtime,
    agentErrors: r.final.agentErrors,
    curve: r.curve.filter((x) => x.day % 20 === 0).map((x) => [x.day, x.population, x.store]),
  });
  console.log(JSON.stringify({ mode, seed, population: rows.at(-1).population, ended200: rows.at(-1).ended200, playerAlive200: rows.at(-1).playerAlive200, causes: rows.at(-1).deathCauses200, errors: r.final.agentErrors }));
}
const pick = (day) => rows.map((r) => r.population[day]);
const avg = (xs) => Number((xs.filter((x) => x !== null).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((x) => x !== null).length)).toFixed(2));
const summary = {
  mode, days, seeds: LONG_SEEDS,
  population30: pick(30), population100: pick(100), population200: pick(200),
  avg30: avg(pick(30)), avg100: avg(pick(100)), avg200: avg(pick(200)),
  births100: rows.reduce((s, r) => s + (r.births[100] ?? 0), 0),
  deaths100: rows.reduce((s, r) => s + (r.deaths[100] ?? 0), 0),
  extinct100: `${rows.filter((r) => r.ended200 && false).length}`,
  extinct100n: `${rows.filter((r) => r.population[100] === 0).length}/${rows.length}`,
  extinct200: `${rows.filter((r) => r.ended200).length}/${rows.length}`,
  deathCauses200: rows.reduce((acc, r) => { for (const [k, n] of Object.entries(r.deathCauses200 ?? {})) acc[k] = (acc[k] ?? 0) + n; return acc; }, {}),
  playerAlive200: rows.map((r) => r.playerAlive200),
  agentErrors: rows.reduce((s, r) => s + r.agentErrors, 0),
};
writeFileSync(join(OUT, `long-run-${mode}-${days}d-head.json`), JSON.stringify({ _说明: `caad92b HEAD 复跑 ${mode} ${days} 日`, at: new Date().toISOString(), rows, summary }, null, 2) + '\n');
console.log(JSON.stringify({ summary }, null, 2));

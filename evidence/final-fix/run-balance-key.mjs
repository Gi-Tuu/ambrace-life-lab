// 审查修复后：正式钟 5 seeds × 200 日复跑（100/200 日关键种子至少 7/29/41）。
// 与 scripts/v11-balance-long-run.mjs 同口径，但写到 evidence/final-fix/，不覆盖已发布台账。
// 额外记录出生日与死亡日，供 P1-3 的 200 日崩落解释使用。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLong, LONG_SEEDS } from '../../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';
import { createSimClock } from '../../life/sim-clock.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT = join(ROOT, 'evidence', 'final-fix');
mkdirSync(OUT, { recursive: true });
const seeds = (process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? LONG_SEEDS.join(','))
  .split(',').map(Number);
const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 200);

const rows = [];
for (const seed of seeds) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  const options = { ...FORMAL_OPTIONS, eventRulesVersion: 2, simTime: true, simClock: clock, minuteMetab: true };
  const r = await runLong(seed, days, { checkpoints: [30, 100, 200].filter((d) => d <= days), options });
  const m = r.milestones;
  const bornEvents = r.birthChecks.filter((b) => b.reason === 'born');
  const reasons = (from, to) => {
    const out = {};
    for (const b of r.birthChecks) if ((b.day ?? 0) >= from && (b.day ?? 0) < to) out[b.reason ?? 'unknown'] = (out[b.reason ?? 'unknown'] ?? 0) + 1;
    return out;
  };
  const row = {
    seed,
    population: { 30: m[30]?.population ?? null, 100: m[100]?.population ?? null, 200: m[200]?.population ?? null },
    births: { 100: m[100]?.births ?? null, 200: m[200]?.births ?? null },
    birthDays: bornEvents.map((b) => b.day),
    birthReasonsBefore100: reasons(0, 100),
    birthReasonsAfter100: reasons(100, 201),
    deaths: { 100: m[100]?.deaths ?? null, 200: m[200]?.deaths ?? null },
    deathCauses200: m[200]?.deathCauses ?? m[100]?.deathCauses ?? {},
    deathRows: r.deaths.map((d) => ({ day: d.day, id: d.id, name: d.name, cause: d.cause })),
    ended200: m[200]?.ended ?? null,
    playerAlive200: m[200]?.playerAlive ?? m[100]?.playerAlive ?? null,
    playerViab200: m[200]?.playerViab ?? m[100]?.playerViab ?? null,
    store200: m[200]?.store ?? null,
    birthsAfter100: bornEvents.filter((b) => b.day > 100).length,
    deathsAfter100: r.deaths.filter((d) => d.day > 100).length,
    curve: r.curve.filter((x) => x.day % 20 === 0).map((x) => [x.day, x.population, x.store]),
    runtime: r.runtime,
    agentErrors: r.final.agentErrors,
  };
  rows.push(row);
  console.log(JSON.stringify({ seed, population: row.population, births: row.births, birthDays: row.birthDays,
    causes: row.deathCauses200, playerAlive200: row.playerAlive200, birthsAfter100: row.birthsAfter100,
    birthReasonsAfter100: row.birthReasonsAfter100, errors: r.final.agentErrors }));
}
const pick = (day) => rows.map((r) => r.population[day]);
const avg = (xs) => Number((xs.filter((x) => x !== null).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((x) => x !== null).length)).toFixed(2));
const summary = {
  mode: 'on', days, seeds,
  population30: pick(30), population100: pick(100), population200: pick(200),
  avg30: avg(pick(30)), avg100: avg(pick(100)), avg200: avg(pick(200)),
  births100: rows.reduce((s, r) => s + (r.births[100] ?? 0), 0),
  deaths100: rows.reduce((s, r) => s + (r.deaths[100] ?? 0), 0),
  extinct100: `${rows.filter((r) => r.population[100] === 0).length}/${rows.length}`,
  extinct200: `${rows.filter((r) => r.ended200).length}/${rows.length}`,
  deathCauses200: rows.reduce((acc, r) => { for (const [k, n] of Object.entries(r.deathCauses200 ?? {})) acc[k] = (acc[k] ?? 0) + n; return acc; }, {}),
  playerAlive200: rows.map((r) => r.playerAlive200),
  agentErrors: rows.reduce((s, r) => s + r.agentErrors, 0),
};
const out = { _说明: `审查修复后正式钟 ${days} 日；mode=on（minuteMetab=true）`, at: new Date().toISOString(), rows, summary };
writeFileSync(join(OUT, `long-run-on-${days}d-after-fix.json`), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ summary }, null, 2));

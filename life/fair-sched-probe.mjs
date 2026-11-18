// V7.3.2 调度公平原型压测：FAIR_SCHED=0/1 × 3 种子 × 30 日，比较空闲、动作、人口/存粮、峰值调用与 tick 时长。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { measureIdle } from './idle-probe.mjs';

const SEEDS = [7, 13, 29];
const DAYS = 30;
const runs = [];
for (const arm of ['off', 'on']) {
  process.env.FAIR_SCHED = arm === 'on' ? '1' : '0';
  if (arm === 'on') process.env.FAIR_DECISION_CAP = process.env.FAIR_DECISION_CAP ?? '6';
  for (const seed of SEEDS) {
    const r = await measureIdle(seed, DAYS);
    const last = r.rows.at(-1);
    runs.push({
      arm, seed, days: DAYS, actualDays: r.actualDays,
      usedMin: r.totals.used, idleMin: r.idleMin, schedulingShare: r.schedulingShare,
      laborMin: r.totals.labor, moveMin: r.totals.move, restMin: r.totals.rest, socialMin: r.totals.social,
      busyTicks: r.totals.busyTicks, opportunityTicks: r.totals.opportunityTicks,
      voluntaryTicks: r.totals.voluntaryTicks, schedulingTicks: r.totals.schedulingTicks,
      voluntaryIdleMin: Number(r.rows.reduce((a, x) => a + x.voluntaryIdleMin, 0).toFixed(1)),
      schedulingIdleMin: Number(r.rows.reduce((a, x) => a + x.schedulingIdleMin, 0).toFixed(1)),
      decisionTicks: r.rows.reduce((a, x) => a + x.decisionTicks, 0),
      store: last?.store ?? null, population: r.population, births: r.births, deaths: r.deaths, actions: r.actions,
      tickMs: r.tickMs, fair: r.fair, ticksRun: r.ticksRun,
      head: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
      fairOn: arm === 'on', cap: Number(process.env.FAIR_DECISION_CAP ?? 6), executedEpisodes: r.fair?.executedEpisodes ?? null, activeDays: r.activeDays,
      popAvg: r.fair ? Number((r.fair.popSum / Math.max(1, r.fair.ticks)).toFixed(2)) : null,
      wait: r.fair?.waitSamples?.length ? { n: r.fair.waitSamples.length,
        mean: Number((r.fair.waitSamples.reduce((a, v) => a + v, 0) / r.fair.waitSamples.length).toFixed(3)),
        max: Math.max(...r.fair.waitSamples) } : null,
    });
    console.log(JSON.stringify({ arm, seed, actualDays: r.actualDays, usedMin: r.totals.used, schedulingShare: r.schedulingShare,
      tickMs: r.tickMs, fair: r.fair ? { calls: r.fair.calls, peakCalls: r.fair.peakCalls, peakAllowed: r.fair.peakAllowed, blocked: r.fair.blocked } : null,
      store: last?.store }));
  }
}
process.env.FAIR_SCHED = '0';
mkdirSync('docs', { recursive: true });
const out = { generatedAt: new Date().toISOString(), seeds: SEEDS, days: DAYS, cap: Number(process.env.FAIR_DECISION_CAP ?? 6), runs,
  note: 'on' ? '' : '' };
out.note = 'FAIR_SCHED=1 only wraps decideOn for formal game; research and default off unchanged';
writeFileSync('docs/fair-sched-v732.json', JSON.stringify(out, null, 2));






// V7.3.2 长程 FAIR on/off：固定 seeds 7/13/29，正式游戏，玩家闲置；只测不改规则。
// 用法：node life/fair-long-probe.mjs 100
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { measureIdle } from './idle-probe.mjs';

const DAYS = Number(process.argv[2] ?? 100);
const SEEDS = [7, 13, 29];
const runs = [];
for (const arm of ['off', 'on']) {
  process.env.FAIR_SCHED = arm === 'on' ? '1' : '0';
  if (arm === 'on') process.env.FAIR_DECISION_CAP = process.env.FAIR_DECISION_CAP ?? '8';
  for (const seed of SEEDS) {
    const t0 = Date.now();
    const r = await measureIdle(seed, DAYS);
    const last = r.rows.at(-1);
    const run = {
      arm, seed, days: DAYS, actualDays: r.actualDays, elapsedMs: Date.now() - t0,
      population: r.population, births: r.births, deaths: r.deaths,
      store: last?.store ?? null, laborMin: r.totals.labor, usedMin: r.totals.used,
      opportunityTicks: r.totals.opportunityTicks,
      voluntaryTicks: r.totals.voluntaryTicks, schedulingTicks: r.totals.schedulingTicks,
      voluntaryIdleMin: Number(r.rows.reduce((a, x) => a + x.voluntaryIdleMin, 0).toFixed(1)),
      schedulingIdleMin: Number(r.rows.reduce((a, x) => a + x.schedulingIdleMin, 0).toFixed(1)),
      actions: r.actions, tickMs: r.tickMs, ticksRun: r.ticksRun,
      popPeak: r.fair?.popPeak ?? null, popAvg: r.fair ? Number((r.fair.popSum / Math.max(1, r.fair.ticks)).toFixed(2)) : null,
      peakEligible: r.fair?.peakEligible ?? null, underfundedTicks: r.fair?.underfundedTicks ?? null,
      grantedEpisodes: r.fair?.allowed ?? null,
      wait: r.fair?.waitSamples?.length ? { n: r.fair.waitSamples.length,
        mean: Number((r.fair.waitSamples.reduce((a, v) => a + v, 0) / r.fair.waitSamples.length).toFixed(3)),
        max: Math.max(...r.fair.waitSamples) } : null,
      head: (() => { try { return execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(); } catch { return 'unknown'; } })(),
      fair: r.fair ? { calls: r.fair.calls, peakCalls: r.fair.peakCalls, peakAllowed: r.fair.peakAllowed,
        blockedTicks: r.fair.blockedTicks, debtMax: r.fair.debtMax, extraEpisodes: r.fair.extraEpisodes } : null,
    };
    runs.push(run);
    console.log(JSON.stringify({ arm, seed, days: DAYS, pop: run.population, births: run.births, deaths: run.deaths,
      store: run.store, labor: run.laborMin, completion: run.actions ? `${run.actions.success}/${run.actions.attempt}` : null,
      volT: run.voluntaryTicks, schedT: run.schedulingTicks, tick: run.tickMs?.avg, elapsedMs: run.elapsedMs }));
  }
}
process.env.FAIR_SCHED = '0';
mkdirSync('docs', { recursive: true });
const out = { generatedAt: new Date().toISOString(), seeds: SEEDS, days: DAYS, runs,
  note: 'fixed seeds, formal game, idle player; FAIR_SCHED=1 uses episode cap 8; no rule changes' };
writeFileSync(`docs/fair-long-${DAYS}-v732.json`, JSON.stringify(out, null, 2));



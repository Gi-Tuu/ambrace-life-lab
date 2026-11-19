// V7.4.0 只读行为质量基线：身份/人格/阶段/需求/活动/目标/社交/关系/事件/节律/重复。
// 不修改世界、不调 RNG；同 seed 的“无观测” world 与“有观测” world 最终 dump 必须逐位一致。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { costFor } from './action-cost.mjs';
import { clockOf } from './resident-time.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { residentStage, ageDays } from './households.mjs';
import { isAlive } from './body.mjs';

export const BEHAVIOR_HEAD = (() => {
  try { return process.env.GIT_HEAD ?? 'unknown'; } catch { return 'unknown'; }
})();
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bucketOf = (hour) => (hour >= 6 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'day' : hour >= 18 && hour < 22 ? 'dusk' : 'night');
const LAYERS = ['reflex', 'habit', 'deliberation', 'discovery', 'rejected', 'refused'];
const minuteOf = (kind) => costFor(kind).minutes;

async function runPlain(seed, days) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(sp);
  return { sp, hash: sha(dumpSurv(sp)) };
}

export async function measureBehavior(seed = 7, days = 30) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  const w = sp.world;
  const startT = w.t;
  const residents = {};
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    residents[a.id] = {
      id: a.id, name: a.name, sex: w.sex?.[a.id] ?? null, archetype: a.traits?.archetype ?? null,
      goals: a.traits?.goals ?? null, bornAt: w.t,
      days: {}, actions: {}, layers: {}, buckets: {}, social: {}, minutes: 0, actionTicks: 0,
      goalChanges: 0, lastGoal: null, maxRun: 0, lastKind: null, run: 0, moves: {}, inactiveTicks: 0,
    };
  }
  const logStart = sp.log.length;
  const events = [];
  let tickCount = 0;
  for (let i = 0; i < days * DAY_TICKS; i += 1) {
    await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
      const r = residents[agent.id];
      if (!r) return;
      const day = dayOf(w.t);
      const d = (r.days[day] ??= { actions: 0, minutes: 0, layers: {}, kinds: {}, social: 0, goal: null, energySum: 0, samples: 0 });
      const hour = w.t % DAY_TICKS;
      const bucket = bucketOf(hour);
      for (const row of rows) {
        if (!row.kind || row.ok === false) continue;
        const kind = row.kind;
        const mins = minuteOf(kind);
        d.actions += 1; d.minutes += mins;
        d.layers[row.layer ?? 'unknown'] = (d.layers[row.layer ?? 'unknown'] ?? 0) + 1;
        d.kinds[kind] = (d.kinds[kind] ?? 0) + 1;
        r.actions[kind] = (r.actions[kind] ?? 0) + 1;
        r.minutes += mins;
        r.layers[row.layer ?? 'unknown'] = (r.layers[row.layer ?? 'unknown'] ?? 0) + 1;
        const b = (r.buckets[bucket] ??= { actions: 0, kinds: {} });
        b.actions += 1; b.kinds[kind] = (b.kinds[kind] ?? 0) + 1;
        if (kind === 'talk') {
          const target = row.target ?? row.action?.target ?? row.about ?? null;
          d.social += 1;
          if (target) r.social[target] = (r.social[target] ?? 0) + 1;
          events.push({ t: w.t, actor: agent.id, kind, layer: row.layer ?? null, target });
        }
        if (kind === 'move_to' || kind === 'move') {
          const loc = row.target ?? row.to ?? null;
          if (loc) r.moves[loc] = (r.moves[loc] ?? 0) + 1;
        }
        if (r.lastKind === kind) r.run += 1; else { r.lastKind = kind; r.run = 1; }
        r.maxRun = Math.max(r.maxRun, r.run);
      }
      d.energySum += agent.drives?.v?.energy ?? 0; d.samples += 1;
      const goal = agent.m3Last?.goal ?? null;
      d.goal = goal;
      if (goal !== r.lastGoal) { r.goalChanges += 1; r.lastGoal = goal; }
    } });
    tickCount += 1;
    const day = dayOf(w.t);
    for (const a of Object.values(w.agents)) {
      if (a.isPlayer || !residents[a.id] || !isAlive(a)) continue;
      const r = residents[a.id];
      const d = (r.days[day] ??= { actions: 0, minutes: 0, layers: {}, kinds: {}, social: 0, goal: null, energySum: 0, samples: 0 });
      d.energySum += a.drives?.v?.energy ?? 0; d.samples += 1;
      if (d.actions === 0) r.inactiveTicks += 1;
      else r.actionTicks += 1;
    }
  }
  for (const row of sp.log.slice(logStart)) if (row.t >= startT) events.push({ t: row.t, actor: null, kind: row.kind, code: row.code ?? null });
  const identity = Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({
    id: a.id, name: a.name, stage: residentStage(w, a.id), ageDays: Math.floor(ageDays(w, a.id)),
    alive: isAlive(a), sex: w.sex?.[a.id] ?? null, archetype: a.traits?.archetype ?? null, goals: a.traits?.goals ?? null,
    energy: Number((a.drives?.v?.energy ?? 0).toFixed(3)), viability: Number((a.viab?.v ?? 0).toFixed(3)),
    relations: [...(a.relations?.map?.entries?.() ?? [])].map(([id, r]) => ({ id, familiarity: Number(r.familiarity.toFixed(3)), trust: Number(r.trust.toFixed(2)) })),
  }));
  const residentRows = Object.values(residents).map((r) => {
    const dayList = Object.values(r.days);
    const validDays = dayList.filter((d) => d.samples >= 20 && d.actions >= 0).length;
    return {
      id: r.id, name: r.name, sex: r.sex, archetype: r.archetype, goals: r.goals,
      actions: r.actions, layers: r.layers, buckets: r.buckets, social: r.social,
      minutes: r.minutes, actionTicks: r.actionTicks, inactiveTicks: r.inactiveTicks,
      goalChanges: r.goalChanges, maxSameKindRun: r.maxRun, moves: r.moves,
      validDays, dayRows: Object.entries(r.days).map(([day, d]) => ({ day: Number(day), ...d })),
    };
  });
  const control = await runPlain(seed, days);
  const observedAgain = await runPlain(seed, days);
  return {
    seed, daysRequested: days, ticks: tickCount, actualTicks: w.t - startT,
    head: BEHAVIOR_HEAD, config: { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES },
    population: identity.filter((a) => a.alive).length, identity,
    residentRows, events, eventsCount: events.length,
    world: { store: w.survival.store, food: { ...(w.survival.food ?? {}) }, births: w.survival.births ?? 0,
      deaths: (w.survival.deaths ?? []).length, day: dayOf(w.t) },
    nonPerturbation: {
      observedHash: sha(dumpSurv(sp)), controlHash: control.hash, repeatHash: observedAgain.hash,
      equalControl: sha(dumpSurv(sp)) === control.hash, equalRepeat: sha(dumpSurv(sp)) === observedAgain.hash,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('behavior-quality-probe.mjs')) {
  const tag = process.argv[2] ?? 'v740';
  const seeds = [7, 13, 29];
  const runs = [];
  for (const s of seeds) runs.push(await measureBehavior(s, 30));
  const out = { tag, generatedAt: new Date().toISOString(), seeds, runs,
    summary: { ticks: runs.map((r) => r.ticks), population: runs.map((r) => r.population),
      events: runs.map((r) => r.eventsCount), nonPerturbation: runs.map((r) => r.nonPerturbation) } };
  mkdirSync('evidence/v740', { recursive: true });
  writeFileSync(`evidence/v740/behavior-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
}


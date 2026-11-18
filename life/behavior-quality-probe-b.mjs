// V7.4.0b 只读观测：生命周期/时间/目标/关系序列/循环诊断；不写世界、不耗 RNG。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { costFor } from './action-cost.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS, dayOf, survivalPhaseOf, seasonOf } from './clock.mjs';
import { residentStage, ageDays } from './households.mjs';
import { isAlive } from './body.mjs';

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const head = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const relSnap = (a) => Object.fromEntries([...(a.relations?.map?.entries?.() ?? [])].map(([id, r]) => [id, { familiarity: r.familiarity, trust: r.trust }]));

export async function runPlain(seed, days) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(sp);
  return { sp, hash: sha(dumpSurv(sp)) };
}

export async function measureBehaviorB(seed = 7, days = 30) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  const w = sp.world;
  const startTick = w.t;
  const residents = new Map();
  const order = [];
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    residents.set(a.id, { id: a.id, name: a.name, initial: true, birthTick: null, deathTick: null,
      stages: [{ tick: w.t, stage: residentStage(w, a.id) }], active: 0, inactive: 0, demand: [], goals: [],
      relations: [], actions: [], ticks: 0 });
    order.push(a.id);
  }
  const familyEvents = [];
  const logStart = sp.log.length;
  for (let i = 0; i < days * DAY_TICKS; i += 1) {
    const day = Math.floor(i / DAY_TICKS);
    const beforeRel = new Map();
    for (const a of Object.values(w.agents)) if (!a.isPlayer && residents.has(a.id)) beforeRel.set(a.id, relSnap(a));
    const tickRows = [];
    await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
      for (const r of rows) if (r.kind && r.ok !== false) tickRows.push({ actor: agent.id, ...r, loc: w.loc[agent.id] });
    } });
    const t = w.t;
    const phase = survivalPhaseOf(t);
    for (const a of Object.values(w.agents)) {
      if (a.isPlayer) continue;
      if (!residents.has(a.id)) {
        residents.set(a.id, { id: a.id, name: a.name, initial: false, birthTick: t, deathTick: null,
          stages: [{ tick: t, stage: residentStage(w, a.id) }], active: 0, inactive: 0, demand: [], goals: [], relations: [], actions: [], ticks: 0 });
        order.push(a.id);
      }
      const rec = residents.get(a.id);
      if (!rec.initial && rec.birthTick == null) rec.birthTick = t;
      if (!isAlive(a)) {
        if (rec.deathTick == null) rec.deathTick = t;
        continue;
      }
      rec.ticks += 1;
      const actRows = tickRows.filter((r) => r.actor === a.id);
      if (actRows.length) rec.active += 1; else rec.inactive += 1;
      rec.demand.push({ day, tick: t, phase, energy: Number((a.drives?.v?.energy ?? 0).toFixed(4)), viab: Number((a.viab?.v ?? 0).toFixed(4)), loc: w.loc[a.id] ?? null });
      const stage = residentStage(w, a.id);
      if (rec.stages.at(-1).stage !== stage) rec.stages.push({ tick: t, stage });
      if (a.ch?.m3) rec.goals.push({ day, tick: t, goal: a.m3Last?.goal ?? null, remaining: a.m3Last?.remaining ?? null,
        reused: a.m3Last?.reused ?? null, interrupted: a.m3Last?.interrupted ?? null });
      for (const r of actRows) rec.actions.push({ day, tick: t, kind: r.kind, layer: r.layer ?? null,
        minutes: costFor(r.kind).minutes, loc: r.loc, target: r.target ?? r.action?.target ?? r.about ?? null });
      const b = beforeRel.get(a.id) ?? {};
      for (const r of actRows) {
        if (r.kind !== 'talk' || !r.target) continue;
        const before = b[r.target] ?? null;
        const after = relSnap(a)[r.target] ?? null;
        rec.relations.push({ tick: t, day, from: a.id, to: r.target, kind: 'talk', before, after,
          dFamiliarity: before && after ? Number((after.familiarity - before.familiarity).toFixed(4)) : null,
          dTrust: before && after ? Number((after.trust - before.trust).toFixed(4)) : null });
      }
    }
    // 共场（去重对）
    const byLoc = {};
    for (const a of Object.values(w.agents)) if (!a.isPlayer && isAlive(a)) (byLoc[w.loc[a.id]] ??= []).push(a.id);
    for (const [loc, ids] of Object.entries(byLoc)) if (ids.length > 1) for (let x = 0; x < ids.length; x += 1) for (let y = x + 1; y < ids.length; y += 1) {
      const from = ids[x], to = ids[y];
      const a = w.agents[from];
      residents.get(from)?.relations.push({ tick: t, day, from, to, kind: 'copresence', loc, before: null, after: relSnap(a)[to] ?? null });
    }
  }
  for (const row of sp.log.slice(logStart)) if (['birth', 'death', 'marriage', 'storm_warning', 'storm_impact'].includes(row.kind)) familyEvents.push({ t: row.t, kind: row.kind, code: row.code ?? null });
  const living = Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a));
  const roster = [...residents.values()].map((r) => ({ id: r.id, name: r.name, initial: r.initial, birthTick: r.birthTick,
    deathTick: r.deathTick, alive: living.some((a) => a.id === r.id), stages: r.stages,
    active: r.active, inactive: r.inactive, validTicks: r.ticks,
    demandSamples: r.demand.length, goalSamples: r.goals.length, relationSamples: r.relations.length,
    phases: r.demand.reduce((acc, x) => { acc[x.phase] = (acc[x.phase] ?? 0) + 1; return acc; }, {}),
    actions: r.actions.length, actionMinutes: r.actions.reduce((s, x) => s + x.minutes, 0),
    traitGoals: w.agents[r.id]?.traits?.goals ?? null, archetype: w.agents[r.id]?.traits?.archetype ?? null,
    sex: w.sex?.[r.id] ?? null }));
  // 关系时间序列 + 循环诊断
  for (const r of residents.values()) {
    const seq = r.actions.map((x) => ({ t: x.tick, kind: x.kind, loc: x.loc }));
    const cycles = [];
    for (let i = 2; i < seq.length; i += 1) {
      if (seq[i].loc && seq[i].loc === seq[i - 2].loc && seq[i].loc !== seq[i - 1].loc) {
        cycles.push({ type: 'A-B-A', actor: r.id, ticks: [seq[i - 2].t, seq[i - 1].t, seq[i].t], loc: seq[i].loc });
      }
    }
    r.cycles = cycles.slice(0, 20);
    r.moves = seq.filter((x) => x.kind === 'move_to').length;
    r.actionsByKind = seq.reduce((a, x) => { a[x.kind] = (a[x.kind] ?? 0) + 1; return a; }, {});
  }
  const m3Enabled = [...residents.keys()].some((id) => w.agents[id]?.ch?.m3 === 1) || w.survival?.m3 === true;
  const control = await runPlain(seed, days);
  const repeat = await runPlain(seed, days);
  return {
    seed, days, ticks: days * DAY_TICKS, actualTicks: w.t - startTick, head,
    config: { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, m3Enabled, faIr: process.env.FAIR_SCHED === '1', cap: process.env.FAIR_DECISION_CAP ?? null, model: process.env.BRAIN ?? 'local' },
    season: seasonOf(dayOf(w.t)), observationDays: days,
    population: living.length, births: roster.filter((r) => !r.initial).length, deaths: roster.filter((r) => r.deathTick != null).length,
    store: w.survival.store,
    roster, familyEvents,
    lifecycle: { initial: [...residents.values()].filter((r) => r.initial).map((r) => r.id),
      births: [...residents.values()].filter((r) => !r.initial).map((r) => [r.id, r.birthTick]),
      deaths: [...residents.values()].filter((r) => r.deathTick != null).map((r) => [r.id, r.deathTick]),
      sampled: order },
    goalState: { m3Enabled, note: m3Enabled ? 'M3 enabled; see goalSamples' : '机制未启用（ch.m3=0）：goalChanges=0 不代表缺少自主目标，需求/价值偏好仍在 traits.goals' },
    relations: Object.fromEntries([...residents.values()].map((r) => [r.id, r.relations.slice(0, 400)])),
    cycles: Object.fromEntries([...residents.values()].map((r) => [r.id, { moves: r.moves, byKind: r.actionsByKind, cycles: r.cycles }])),
    nonPerturbation: { observedHash: sha(dumpSurv(sp)), controlHash: control.hash, repeatHash: repeat.hash,
      equalControl: sha(dumpSurv(sp)) === control.hash, equalRepeat: sha(dumpSurv(sp)) === repeat.hash },
  };
}

if (process.argv[1] && process.argv[1].endsWith('behavior-quality-probe-b.mjs')) {
  const tag = process.argv[2] ?? 'v740b';
  const days = Number(process.argv[3] ?? 30);
  const seeds = [7, 13, 29];
  const runs = [];
  for (const s of seeds) runs.push(await measureBehaviorB(s, days));
  const out = { tag, generatedAt: new Date().toISOString(), seeds, days, head,
    runs, summary: { population: runs.map((r) => r.population), births: runs.map((r) => r.births),
      deaths: runs.map((r) => r.deaths), nonPerturbation: runs.map((r) => r.nonPerturbation) } };
  mkdirSync('evidence/v740b', { recursive: true });
  writeFileSync(`evidence/v740b/behavior-${tag}-${days}d.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
}


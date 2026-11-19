// V7.4.1 只读：拆 M3 abort。包装 m3Choose/planner.step，记录目标/候选/过滤原因/资源/busy；不改默认。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { clockOf } from './resident-time.mjs';
import { costFor } from './action-cost.mjs';
import { isAlive } from './body.mjs';

const M3_KINDS = new Set(['rest', 'eat', 'move_to', 'talk', 'look_out', 'take_shared']);
const brief = (paths) => paths.map((p) => ({ id: p.id, kind: p.kind, target: p.target ?? null, to: p.to ?? null, cost: p.cost ?? null }));
const kinds = (paths) => paths.reduce((a, p) => { a[p.kind] = (a[p.kind] ?? 0) + 1; return a; }, {});

function classify(code, goal, busy) {
  if (busy) return '调度无机会/busy';
  if (code === 'only_coupling_actions') return '动作集不匹配/仅耦合';
  if (code === 'committed_goal_unavailable') return '目标不可达';
  if (code === 'no_eligible_action') return '动作集不匹配';
  if (code === 'planner_rejected') return '规划器异常';
  return '其他';
}

export async function diagnoseAbort(seed = 7, days = 30) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const w = sp.world;
  const aborts = [];
  const starts = [];
  const meta = new Map();
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    const rec = { startTick: null, goal: null, plans: [], actions: [], paths: [] };
    meta.set(a.id, rec);
    const planner = a.m3Planner;
    const step = planner.step.bind(planner);
    planner.step = (input) => { const r = step(input); rec.plans = r.plans ?? []; rec.actions = input?.actions ?? []; return r; };
    const choose = a.m3Choose.bind(a);
    a.m3Choose = (world, paths) => {
      const before = a.m3Last?.goal ?? null;
      rec.plans = []; rec.actions = [];
      const clock = clockOf(world, a.id);
      const pre = { t: world.t, day: dayOf(world.t), loc: world.loc[a.id], energy: Number((a.drives?.v?.energy ?? 0).toFixed(3)),
        store: world.survival?.store ?? null, busy: Boolean(clock?.busy), candidates: brief(paths), kinds: kinds(paths) };
      rec.paths = paths;
      const out = choose(world, paths);
      const after = a.m3Last?.goal ?? null;
      const code = a.m3Last?.interrupted ?? null;
      const kept = new Set(out.map((p) => p.id));
      const dropped = paths.filter((p) => !kept.has(p.id)).map((p) => ({ id: p.id, kind: p.kind, target: p.target ?? null,
        reason: !M3_KINDS.has(p.kind) ? 'non_m3_kind' : (p.kind === 'talk' ? 'talk_cap_or_goal_filter' : 'goal_filter') }));
      const plannedKinds = rec.actions.reduce((m, p) => { m[p.kind] = (m[p.kind] ?? 0) + 1; return m; }, {});
      const goalTarget = rec.plans[0]?.first?.target ?? rec.plans[0]?.first?.to ?? rec.plans[0]?.second?.target ?? rec.plans[0]?.second?.to ?? null;
      if (!before && after) { rec.startTick = world.t; rec.goal = after; starts.push({ t: world.t, actor: a.id, goal: after }); }
      if (before && !after && code) {
        const duration = rec.startTick != null ? world.t - rec.startTick : null;
        const category = classify(code, before, pre.busy);
        aborts.push({ tick: world.t, day: pre.day, actor: a.id, goal: before, goalTarget,
          code, duration, startTick: rec.startTick, candidates: pre.candidates, candidateKinds: pre.kinds,
          plannedKinds, plans: rec.plans.slice(0, 5), dropped, droppedCount: dropped.length,
          loc: pre.loc, energy: pre.energy, store: pre.store, busy: pre.busy, category });
        rec.startTick = null; rec.goal = null;
      } else if (before && !after && !code) {
        rec.startTick = null; rec.goal = null;
      }
      return out;
    };
  }
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(sp);
  const byCategory = aborts.reduce((a, x) => { a[x.category] = (a[x.category] ?? 0) + 1; return a; }, {});
  const byCode = aborts.reduce((a, x) => { a[x.code] = (a[x.code] ?? 0) + 1; return a; }, {});
  const byGoal = aborts.reduce((a, x) => { a[x.goal] = (a[x.goal] ?? 0) + 1; return a; }, {});
  const conflict = aborts.filter((x) => x.goal === 'connect' && !x.plannedKinds?.talk).length;
  return { seed, days, population: Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a)).length,
    starts: starts.length, aborts: aborts.length, byCategory, byCode, byGoal,
    onlyCoupling: aborts.filter((x) => x.code === 'only_coupling_actions').length,
    goalSurvivalConflict: conflict, examples: aborts.slice(0, 8) };
}

if (process.argv[1] && process.argv[1].endsWith('v741-abort-diagnose.mjs')) {
  const days = Number(process.argv[2] ?? 30);
  const runs = [];
  for (const seed of [7, 13, 29]) runs.push(await diagnoseAbort(seed, days));
  mkdirSync('evidence/v741', { recursive: true });
  writeFileSync(`evidence/v741/abort-diagnose-${days}d.json`, JSON.stringify({ generatedAt: new Date().toISOString(), days, runs }, null, 2));
  console.log(JSON.stringify(runs.map((r) => ({ seed: r.seed, pop: r.population, starts: r.starts, aborts: r.aborts,
    byCategory: r.byCategory, byCode: r.byCode, byGoal: r.byGoal, onlyCoupling: r.onlyCoupling, conflict: r.goalSurvivalConflict })), null, 2));
}


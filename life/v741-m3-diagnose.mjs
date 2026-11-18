// V7.4.1 诊断（只读）：M3 abort 根因 + 社交剥离位置。仅实验进程包装，不改源码默认。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { isAlive } from './body.mjs';
import { DAY_TICKS } from './clock.mjs';

const kindsOf = (paths) => paths.reduce((a, p) => { a[p.kind] = (a[p.kind] ?? 0) + 1; return a; }, {});

export async function diagnose(seed = 7, days = 30, m3 = true) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3 } });
  const w = sp.world;
  const events = [];
  const meta = new Map();
  const talkExec = [];
  const decisions = [];
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    meta.set(a.id, { goalStart: null, goal: null, lastPlans: [] });
    if (!m3) continue;
    const planner = a.m3Planner;
    const origStep = planner.step.bind(planner);
    planner.step = (...args) => { const r = origStep(...args); const m = meta.get(a.id); m.lastPlans = r.plans ?? []; m.lastActions = args?.[0]?.actions ?? []; return r; };
    const origChoose = a.m3Choose.bind(a);
    a.m3Choose = (world, paths) => {
      const before = a.m3Last?.goal ?? null;
      const rec0 = meta.get(a.id); rec0.lastPlans = []; rec0.lastActions = [];
      const cand = kindsOf(paths);
      const returned = origChoose(world, paths);
      const after = a.m3Last?.goal ?? null;
      const interrupted = a.m3Last?.interrupted ?? null;
      const rec = meta.get(a.id);
      const plannedKinds = rec.lastActions.reduce((m, p) => { m[p.kind] = (m[p.kind] ?? 0) + 1; return m; }, {});
      decisions.push({ t: w.t, actor: a.id, goal: after, before, candidates: cand, plannedKinds, planFirst: rec.lastPlans.map((p) => p.first?.kind ?? null), filteredTalk: returned.filter((p) => p.kind === 'talk').length, filteredCount: returned.length, interrupted });
      if (!before && after) { rec.goalStart = w.t; rec.goal = after; }
      if (interrupted === 'only_coupling_actions') { rec0.goalStart = null; rec0.goal = null; return returned; }
      if (before && !after && interrupted) {
        const duration = rec.goalStart != null ? w.t - rec.goalStart : null;
        events.push({ t: w.t, actor: a.id, kind: 'abort', code: interrupted, previousGoal: before,
          duration, remaining: a.m3Last?.remaining ?? null, candidates: cand, candidatesTotal: paths.length,
          planFirst: rec.lastPlans.map((p) => p.first?.kind ?? null), filteredCount: returned.length,
          filteredTalk: returned.filter((p) => p.kind === 'talk').length,
          loc: w.loc[a.id], energy: Number((a.drives?.v?.energy ?? 0).toFixed(3)), pantry: w.survival?.store ?? 0 });
        rec.goalStart = null; rec.goal = null;
      } else if (before && !after && !interrupted) {
        events.push({ t: w.t, actor: a.id, kind: 'complete', previousGoal: before, duration: rec.goalStart != null ? w.t - rec.goalStart : null,
          candidates: cand, planFirst: rec.lastPlans.map((p) => p.first?.kind ?? null), filteredCount: returned.length });
        rec.goalStart = null; rec.goal = null;
      }
      return returned;
    };
  }
  await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
    for (const r of rows) if (r.kind === 'talk' && r.ok !== false) talkExec.push({ t: w.t, actor: agent.id, target: r.target ?? r.action?.target ?? null });
  } });
  for (let i = 1; i < days * DAY_TICKS; i += 1) {
    await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
      for (const r of rows) if (r.kind === 'talk' && r.ok !== false) talkExec.push({ t: w.t, actor: agent.id, target: r.target ?? r.action?.target ?? null });
    } });
  }
  // 第二轮：候选/过滤计数（m3 on 时逐 tick 手动包 m3Choose 已在上方；此处只汇总执行 talk）
  const abort = events.filter((e) => e.kind === 'abort');
  const byCode = abort.reduce((a, e) => { a[e.code] = (a[e.code] ?? 0) + 1; return a; }, {});
  const byGoal = abort.reduce((a, e) => { a[e.previousGoal] = (a[e.previousGoal] ?? 0) + 1; return a; }, {});
  const buckets = abort.reduce((a, e) => {
    const key = e.code === 'committed_goal_unavailable' ? '目标不可达/承诺动作不可用'
      : e.code === 'no_eligible_action' ? '动作集不匹配/无合格动作'
      : e.code === 'planner_rejected' ? '规划器异常'
      : '其他';
    a[key] = (a[key] ?? 0) + 1; return a;
  }, {});
  return {
    seed, days, m3, population: Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a)).length,
    abort: abort.length, complete: events.filter((e) => e.kind === 'complete').length,
    byCode, byGoal, buckets, talkExecuted: talkExec.length,
    talkCandidatesSeen: decisions.reduce((a, e) => a + (e.candidates?.talk ?? 0), 0),
    talkPlanned: decisions.reduce((a, e) => a + (e.planFirst ?? []).filter((k) => k === 'talk').length, 0),
    talkPlannedActions: decisions.reduce((a, e) => a + (e.plannedKinds?.talk ?? 0), 0),
    talkFiltered: decisions.reduce((a, e) => a + (e.filteredTalk ?? 0), 0),
    talkKept: decisions.reduce((a, e) => a + (e.filteredTalk ?? 0), 0),
    skipOnlyCoupling: decisions.filter((e) => e.interrupted === 'only_coupling_actions').length,
    decisionTicks: decisions.length, m3OffTalk: m3 ? null : talkExec.length, decisionsSample: decisions.slice(0, 5),
    examples: abort.slice(0, 10),
  };
}

if (process.argv[1] && process.argv[1].endsWith('v741-m3-diagnose.mjs')) {
  const days = Number(process.argv[2] ?? 30);
  const out = [];
  for (const m3 of [true, false]) for (const seed of [7, 13, 29]) out.push(await diagnose(seed, days, m3));
  mkdirSync('evidence/v741', { recursive: true });
  writeFileSync(`evidence/v741/diagnose-${days}d.json`, JSON.stringify({ generatedAt: new Date().toISOString(), days, runs: out }, null, 2));
  console.log(JSON.stringify(out.map((r) => ({ seed: r.seed, m3: r.m3, pop: r.population, abort: r.abort,
    complete: r.complete, byCode: r.byCode, buckets: r.buckets, talkExec: r.talkExecuted,
    talkPlanned: r.talkPlanned, talkCands: r.talkCandidatesSeen, talkFiltered: r.talkFiltered })), null, 2));
}



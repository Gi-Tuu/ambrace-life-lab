// V7.4.1 研究态实验（只读）：M3 目标事件、关系来源分解、互动后重复选择、移动 3/6/12 刻窗口。
// 开关仅为 residentChannelMask.m3；不写世界、不耗 RNG、不改默认。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { isAlive } from './body.mjs';

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const head = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const goalOf = (a) => a?.m3Last?.goal ?? null;
const goalId = (g) => (g && typeof g === 'object' ? g.id ?? g.kind ?? JSON.stringify(g) : g ?? null);
const relOf = (a, id) => { const r = a.relations?.map?.get(id); return r ? { familiarity: Number(r.familiarity.toFixed(4)), trust: Number(r.trust.toFixed(2)) } : null; };
const LABOR = new Set(['gather', 'forage', 'harvest', 'plant', 'water', 'till', 'build', 'repair', 'plan', 'expand', 'road_lay', 'road_remove']);

async function runPlain(seed, days, m3) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3 } });
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(sp);
  return sha(dumpSurv(sp));
}

export async function runGroup(seed = 7, days = 30, m3 = false) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3 } });
  const w = sp.world;
  const residents = [...Object.values(w.agents).filter((a) => !a.isPlayer)];
  const goalEvents = [];
  const relationEvents = [];
  const actions = [];
  const repeats = [];
  const prevGoal = new Map();
  const goalStart = new Map();
  const goalLifecycle = [];
  for (const a of residents) prevGoal.set(a.id, null);
  for (let i = 0; i < days * DAY_TICKS; i += 1) {
    const beforeRel = new Map();
    for (const a of residents) beforeRel.set(a.id, new Map([...(a.relations?.map?.entries?.() ?? [])].map(([id, r]) => [id, { ...r }])));
    const beforeGoal = new Map(residents.map((a) => [a.id, goalOf(a)]));
    const rowsByActor = new Map();
    const occupants = {};
    for (const a of residents) if (isAlive(a)) (occupants[w.loc[a.id]] ??= []).push(a.id);
    await tickSurvPlay(sp, { onResidentAction: (agent, rows) => {
      const list = (rowsByActor.get(agent.id) ?? []);
      for (const r of rows) if (r.kind && r.ok !== false) {
        const loc = w.loc[agent.id];
        list.push({ t: w.t, kind: r.kind, layer: r.layer ?? null, loc, target: r.target ?? r.action?.target ?? r.about ?? null });
        actions.push({ t: w.t, actor: agent.id, kind: r.kind, layer: r.layer ?? null, loc, target: r.target ?? r.action?.target ?? r.about ?? null });
      }
      rowsByActor.set(agent.id, list);
    } });
    const t = w.t;
    for (const a of residents) {
      if (!isAlive(a)) continue;
      const rows = rowsByActor.get(a.id) ?? [];
      // M3 目标事件（只取规划器真实状态）
      const bg = beforeGoal.get(a.id), ag = goalOf(a), bId = goalId(bg), aId = goalId(ag);
      if (a.ch?.m3) {
        let type = null, reason = null;
        if (!bId && aId) type = 'start';
        else if (bId && aId && bId !== aId) type = 'switch';
        else if (bId && !aId) type = a.m3Last?.interrupted ? 'abort' : 'complete';
        else if (bId && aId && Number(ag?.remaining ?? 0) < Number(bg?.remaining ?? 0)) type = 'continue';
        else if (bId && aId && ag?.reused && !bg?.reused) type = 'reuse';
        if (type) {
          if (type === 'abort') reason = a.m3Last?.interrupted ?? null;
          const follow = actions.filter((x) => x.actor === a.id && x.t >= t).slice(0, 5).map((x) => x.kind);
          goalEvents.push({ t, day: dayOf(t), actor: a.id, type, from: bId, to: aId, remaining: ag?.remaining ?? null, reused: ag?.reused ?? null, reason, follow, inferred: false });
          if (type === 'start') goalStart.set(a.id, t);
          if (type === 'switch' || type === 'abort' || type === 'complete') {
            const st = goalStart.get(a.id);
            goalLifecycle.push({ actor: a.id, goal: bId, startTick: st ?? null, endTick: t,
              duration: st != null ? t - st : null, status: type, from: bId, to: aId, reason, inferred: false });
            if (type === 'switch') goalStart.set(a.id, t); else goalStart.delete(a.id);
          }
        }
      }
      // 关系来源分解（当前 actor 的方向）
      const after = a.relations?.map?.entries?.() ? new Map([...(a.relations.map.entries())].map(([id, r]) => [id, { ...r }])) : new Map();
      const before = beforeRel.get(a.id) ?? new Map();
      for (const [other, ar] of after) {
        const br = before.get(other);
        const df = br ? Number((ar.familiarity - br.familiarity).toFixed(4)) : null;
        const dt = br ? Number((ar.trust - br.trust).toFixed(2)) : null;
        if (df == null || (df === 0 && dt === 0)) continue;
        const talk = rows.some((r) => r.kind === 'talk' && r.target === other);
        const source = talk ? 'talk' : (dt === 3 && Math.abs(df - 0.06) < 1e-9 ? 'contact(+3/+0.06)' : 'unattributed');
        relationEvents.push({ t, day: dayOf(t), actor: a.id, other, df, dt,
          before: br ? { familiarity: Number(br.familiarity.toFixed(4)), trust: br.trust } : null,
          after: { familiarity: Number(ar.familiarity.toFixed(4)), trust: ar.trust },
          source, talk: talk ? 'active' : null, inferred: false });
      }
      // 互动后 12 刻重复选择（同一对象）
      for (const r of rows) if (r.kind === 'talk' && r.target) {
        const later = actions.find((x) => x.actor === a.id && x.kind === 'talk' && x.t > t && x.t <= t + 12);
        const pool = (occupants[w.loc[a.id]] ?? []).filter((id) => id !== a.id);
        repeats.push({ t, actor: a.id, target: r.target, laterSame: later ? later.target === r.target : null,
          laterTarget: later?.target ?? null, available: pool.length, initialFamiliarity: before.get(r.target)?.familiarity ?? null });
      }
    }
  }
  // 互动后 12 刻重复选择（用完整动作序列回填，避免循环中看不到未来动作）
  const talks = actions.filter((x) => x.kind === 'talk' && x.target);
  for (const r of repeats) {
    const later = talks.find((x) => x.actor === r.actor && x.t > r.t && x.t <= r.t + 12);
    r.laterSame = later ? later.target === r.target : null;
    r.laterTarget = later?.target ?? null;
  }
  const repeatStats = { n: repeats.length, same: repeats.filter((x) => x.laterSame === true).length,
    different: repeats.filter((x) => x.laterSame === false).length, unknown: repeats.filter((x) => x.laterSame == null).length };
  for (const a of residents) {
    const st = goalStart.get(a.id);
    if (st == null) continue;
    const dur = w.t - st;
    const commit = a.m3Planner?.commitment ?? 4;
    goalLifecycle.push({ actor: a.id, goal: goalOf(a), startTick: st, endTick: w.t, duration: dur,
      status: dur > commit ? 'over-window' : 'ongoing', inferred: false });
  }
  // 移动窗口：3/6/12 刻
  const moveAnalysis = {};
  for (const win of [3, 6, 12]) {
    const cand = actions.filter((x) => x.kind === 'move_to');
    let confirmed = 0, noFollow = 0, aba = 0, returnHome = 0, resourceTrips = 0, labor = 0;
    const examples = [];
    for (let idx = 0; idx < actions.length; idx += 1) {
      const m = actions[idx];
      if (m.kind !== 'move_to') continue;
      const dest = m.loc;
      const after = actions.slice(idx + 1).filter((x) => x.actor === m.actor && x.t > m.t && x.t <= m.t + win);
      const nonMove = after.filter((x) => x.kind !== 'move_to');
      const follow = nonMove.some((x) => x.loc === dest);
      const back = after.some((x) => x.kind === 'move_to' && x.loc !== dest);
      if (follow) { confirmed += 1; if (nonMove.some((x) => LABOR.has(x.kind))) labor += 1; }
      else { noFollow += 1; examples.push({ actor: m.actor, t: m.t, dest, after: after.map((x) => x.kind + '@' + x.loc) }); }
      if (back) aba += 1;
      if (dest === 'home') returnHome += 1;
      if (['yard', 'garden', 'store'].includes(dest) && !follow) resourceTrips += 1;
    }
    moveAnalysis[win] = { denominator: cand.length, confirmed, noFollow, aba, returnHome, resourceTrips, labor, typicalNoFollow: examples.slice(0, 10) };
  }
  const control = await runPlain(seed, days, m3);
  const repeat = await runPlain(seed, days, m3);
  return {
    head, seed, days, ticks: days * DAY_TICKS, m3,
    config: { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3 }, faIr: process.env.FAIR_SCHED === '1' },
    population: residents.filter((a) => isAlive(a)).length,
    goalEnabled: residents.some((a) => a.ch?.m3),
    goalEvents, goalCounts: goalEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {}),
    goalLifecycle, goalLifecycleCounts: goalLifecycle.reduce((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {}),
    relationEvents, relationStats: relationEvents.reduce((acc, e) => { acc[e.source] = (acc[e.source] ?? 0) + 1; return acc; }, {}),
    unlinkedGoalEvents: goalEvents.filter((e) => e.inferred).length,
    repeats, repeatStats,
    agentErrors: { count: w.survival.agentErrors ?? 0,
      samples: sp.log.filter((x) => x.kind === 'agentError').slice(0, 10).map((x) => x.code) },
    moveAnalysis,
    nonPerturbation: { observedHash: sha(dumpSurv(sp)), controlHash: control, repeatHash: repeat,
      equalControl: sha(dumpSurv(sp)) === control, equalRepeat: sha(dumpSurv(sp)) === repeat },
  };
}

if (process.argv[1] && process.argv[1].endsWith('v741-experiment.mjs')) {
  const days = Number(process.argv[2] ?? 30);
  const tag = process.argv[3] ?? 'v741';
  const groups = [];
  for (const m3 of [false, true]) for (const seed of [7, 13, 29]) groups.push(await runGroup(seed, days, m3));
  const out = { tag, generatedAt: new Date().toISOString(), head, days, groups,
    summary: groups.map((g) => ({ seed: g.seed, m3: g.m3, population: g.population, goals: g.goalCounts,
      relations: g.relationStats, repeats: g.repeatStats, move3: g.moveAnalysis[3], nonPerturbation: g.nonPerturbation })) };
  mkdirSync('evidence/v741', { recursive: true });
  writeFileSync(`evidence/v741/experiment-${tag}-${days}d.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary.map((s) => ({ seed: s.seed, m3: s.m3, pop: s.population, goals: s.goals,
    rel: s.relations, rep: s.repeats, move3: { d: s.move3.denominator, ok: s.move3.confirmed, no: s.move3.noFollow, aba: s.move3.aba }, hash: s.nonPerturbation.equalControl })), null, 2));
}



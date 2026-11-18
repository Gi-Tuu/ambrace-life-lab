// V7.3.2 第三批：居民真实自由时间测量（只测不改调度）。
// 逐刻记录：决策机会（trace 是否增长）、劳动/移动/休息/社交分钟、busy、主动空闲、调度空闲。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { clockOf } from './resident-time.mjs';
import { costFor } from './action-cost.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { residentStage, ageDays } from './households.mjs';
import { isAlive } from './body.mjs';
import { ledgerStats } from './action-ledger.mjs';

const LABOR = new Set(['gather', 'forage', 'harvest', 'plant', 'water', 'till', 'build', 'repair', 'plan', 'expand', 'road_lay', 'road_remove', 'house_work']);
const MOVE = new Set(['move_to', 'look_out', 'move']);
const REST = new Set(['rest', 'sleep']);
const SOCIAL = new Set(['talk', 'discuss_open', 'discuss_join', 'discuss_share', 'discuss_decline', 'discuss_leave', 'deafen', 'seclude', 'refuse']);

export async function measureIdle(seed = 7, days = 30) {
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  const w = sp.world;
  const rows = [];
  let sumTick = 0, maxTick = 0, ticksRun = 0;
  const decisionCount = new Map();
  // 纯观测包装：只统计每刻是否真的拿到决策机会（decideOn 调用），不改变调度/结果。
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer || typeof a.decideOn !== 'function') continue;
    decisionCount.set(a.id, 0);
    const original = a.decideOn.bind(a);
    a.decideOn = async (...args) => {
      decisionCount.set(a.id, (decisionCount.get(a.id) ?? 0) + 1);
      return original(...args);
    };
  }
  const state = new Map(); // id -> day accumulator
  const end = dayOf(w.t) + days;
  const minutesOf = (kind) => costFor(kind).minutes;
  for (let guard = 0; dayOf(w.t) < end && guard < days * DAY_TICKS * 2; guard += 1) {
    const before = new Map(Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a)).map((a) => [a.id, {
      trace: a.trace.length, busy: Boolean(clockOf(w, a.id).busy), energy: a.drives?.v?.energy ?? 0,
      decisions: decisionCount.get(a.id) ?? 0,
    }]));
    const tick0 = performance.now();
    await tickSurvPlay(sp);
    const tickMs = performance.now() - tick0; sumTick += tickMs; maxTick = Math.max(maxTick, tickMs); ticksRun += 1;
    const day = dayOf(w.t);
    for (const a of Object.values(w.agents)) {
      if (a.isPlayer || !isAlive(a)) continue;
      const clock = clockOf(w, a.id);
      const b = before.get(a.id);
      let st = state.get(a.id);
      if (!st || st.day !== day) {
        if (st) rows.push(finishDay(w, a, st));
        st = { day, used: 0, labor: 0, move: 0, rest: 0, social: 0, other: 0, busyTicks: 0,
          voluntaryTicks: 0, schedulingTicks: 0, decisionTicks: 0, energySum: 0, ticks: 0, busyMin: 0 };
        state.set(a.id, st);
      }
      const fresh = a.trace.slice(b?.trace ?? a.trace.length).filter((r) => r.t === w.t && r.ok !== false);
      let acted = 0;
      for (const r of fresh) {
        const kind = r.kind ?? r.action?.kind;
        if (!kind) continue;
        const mins = minutesOf(kind);
        acted += mins;
        if (LABOR.has(kind)) st.labor += mins;
        else if (MOVE.has(kind)) st.move += mins;
        else if (REST.has(kind)) st.rest += mins;
        else if (SOCIAL.has(kind)) st.social += mins;
        else st.other += mins;
      }
      if (fresh.length) st.decisionTicks += 1;
      const decision = (decisionCount.get(a.id) ?? 0) > (b?.decisions ?? 0);
      if (b?.busy || clock.busy) { st.busyTicks += 1; st.busyMin += Math.min(DAY_TICKS, 60 - (clock.tick?.usedMin ?? 0)); }
      else if (decision && acted === 0) st.voluntaryTicks += 1;
      else if (!decision && (clock.tick?.usedMin ?? 0) < 60 && (a.drives?.v?.energy ?? 0) > 0.01) st.schedulingTicks += 1;
      st.used = clock.usedMin;
      st.energySum += a.drives?.v?.energy ?? 0;
      st.ticks += 1;
    }
  }
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer || !isAlive(a)) continue;
    const st = state.get(a.id);
    if (st) rows.push(finishDay(w, a, st));
  }
  const totals = rows.reduce((acc, r) => {
    acc.available += r.availableMin; acc.used += r.usedMin; acc.labor += r.laborMin; acc.move += r.moveMin;
    acc.rest += r.restMin; acc.social += r.socialMin; acc.busyTicks += r.busyTicks;
    acc.voluntaryTicks += r.voluntaryTicks; acc.schedulingTicks += r.schedulingTicks;
    return acc;
  }, { available: 0, used: 0, labor: 0, move: 0, rest: 0, social: 0, busyTicks: 0, voluntaryTicks: 0, schedulingTicks: 0 });
  const idleMin = totals.available - totals.used;
  const idleTicks = totals.voluntaryTicks + totals.schedulingTicks;
  return {
    seed, days, actualDays: new Set(rows.map((r) => r.day)).size,
    rows, totals, idleMin,
    schedulingShare: idleTicks ? Number((totals.schedulingTicks / idleTicks).toFixed(4)) : null,
    tickMs: { avg: Number((sumTick / Math.max(1, ticksRun)).toFixed(3)), max: Number(maxTick.toFixed(3)) },
    fair: w.fairSched?.stats ?? null, actions: ledgerStats(w)?.resident ?? null,
    births: w.survival.births ?? 0, deaths: (w.survival.deaths ?? []).length, population: Object.values(w.agents).filter((a) => !a.isPlayer && !a.dead).length,
    definition: {
      voluntary: '本刻有决策 trace 但未产生动作分钟（自己选择不行动）',
      scheduling: '本刻无决策 trace、无 busy、本刻未满且体力可用（有时间/体力但没拿到决策机会）',
      idleMinutes: 'availableMin-usedMin；按 tick 比例拆分为自愿/调度估计',
    },
  };
}

function finishDay(w, a, st) {
  const idle = Math.max(0, 1440 - st.used);
  const idleTicks = st.voluntaryTicks + st.schedulingTicks;
  const schedShare = idleTicks ? st.schedulingTicks / idleTicks : 0;
  return {
    seed: w.seed, day: st.day, id: a.id, name: a.name,
    age: Math.floor(ageDays(w, a.id)), stage: residentStage(w, a.id),
    goals: a.traits?.goals ?? null, archetype: a.traits?.archetype ?? null,
    availableMin: 1440, usedMin: st.used, idleMin: idle,
    laborMin: st.labor, moveMin: st.move, restMin: st.rest, socialMin: st.social, otherMin: st.other,
    busyTicks: st.busyTicks, decisionTicks: st.decisionTicks,
    voluntaryTicks: st.voluntaryTicks, schedulingTicks: st.schedulingTicks,
    voluntaryIdleMin: Number((idle * (1 - schedShare)).toFixed(1)),
    schedulingIdleMin: Number((idle * schedShare).toFixed(1)),
    energyAvg: Number((st.energySum / Math.max(1, st.ticks)).toFixed(3)),
    store: w.survival.store, food: { ...(w.survival.food ?? {}) }, resStock: { ...(w.survival.resStock ?? {}) },
  };
}

if (process.argv[1] && process.argv[1].endsWith('idle-probe.mjs')) {
  const tag = process.argv[2] ?? 'v732';
  const seeds = [7, 13, 29];
  const runs = [];
  for (const s of seeds) runs.push(await measureIdle(s, 30));
  const out = { tag, seeds, days: 30, generatedAt: new Date().toISOString(), runs };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/idle-time-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tag, seeds: runs.map((r) => ({
    seed: r.seed, rows: r.rows.length, usedMin: r.totals.used, idleMin: r.idleMin,
    schedulingShare: r.schedulingShare, busyTicks: r.totals.busyTicks,
  })) }, null, 2));
}






#!/usr/bin/env node
// 1.1 正式钟生存定位探针（只读模拟，不改规则/阈值）。
//
//   node scripts/v11-survival-probe.mjs --mode on     --seed 7 --days 100
//   node scripts/v11-survival-probe.mjs --mode off    --seed 7 --days 100
//   node scripts/v11-survival-probe.mjs --mode legacy --seed 7 --days 100   // 同 FORMAL_OPTIONS，但无 simClock（旧每刻路径）
//   node scripts/v11-survival-probe.mjs --mode p3     --seed 7 --days 100   // P3 GAME_OPTIONS（gameRules false，无 simClock）
//
// 逐日记录：食物产出/消耗、居民饥饿、进食动作成功率、busy 时长、旅行、日长、
// 代谢/劳动成本、死亡原因。输出 JSON 到 evidence/v11-balance/probe-<mode>-<seed>.json。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { GAME_OPTIONS, LONG_SEEDS } from '../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../life/balance-probe.mjs';
import { createSimClock } from '../life/sim-clock.mjs';
import { LEGACY_EVENT_RULES, CURRENT_EVENT_RULES } from '../life/rng.mjs';
import { dayOf } from '../life/clock.mjs';
import { livingResidents } from '../life/body.mjs';
import { costFor } from '../life/action-cost.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'evidence', 'v11-balance');
mkdirSync(OUT, { recursive: true });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const mode = arg('mode', 'on');
const seed = Number(arg('seed', 7));
const days = Number(arg('days', 100));
const step = Number(arg('step', 60)); // 连续钟每次推进多少游戏分钟（1 或 60）；旧路径恒 60
const rules = Number(arg('rules', 2)); // 1 = LEGACY_EVENT_RULES，2 = CURRENT_EVENT_RULES（与 runLong 默认一致）

const options = mode === 'p3' ? { ...GAME_OPTIONS } : { ...FORMAL_OPTIONS, eventRulesVersion: rules === 1 ? LEGACY_EVENT_RULES : CURRENT_EVENT_RULES };
let simClock = null;
if (mode === 'on' || mode === 'off') {
  simClock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  options.simTime = true;
  options.simClock = simClock;
  options.minuteMetab = mode === 'on';
}
const sp = createSurvPlay(seed, options);
const w = sp.world;
const s = w.survival;

// 观测：日界生产/消费账（不改规则）。
const dailyObs = {};
w.observeProduction = (bucket, kind, n) => {
  const d = dayOf(w.t);
  const row = (dailyObs[d] ??= {});
  const k = `${bucket}:${kind}`;
  row[k] = (row[k] ?? 0) + n;
};

const seen = new Set();
const hours = [];
const deaths = [];
const aborts = {}; // 长动作被中止的 code 计数（runner 侧只读日志）
const byKind = {};   // ok 动作计数
const failKind = {}; // 失败 code 计数
const seenLog = new Set();
let thinks = 0, actions = 0, staged = 0;
let busyMinutes = 0, travelHours = 0;


for (let hour = 0; hour < days * 24; hour += 1) {
  const t0 = Date.now();
  for (let k = 0; k < 60 / step; k += 1) {
    await tickSurvPlay(sp, w.simClock ? { minutes: step } : undefined);
  }
  const ms = Date.now() - t0;
  if (w.simClock && hour % 60 === 0) {
    // 旅行/睡眠占比：每小时采样一次在场状态
  }
  // 从 trace 增量统计（trace 会被裁剪，故用对象身份去重）
  for (const r of sp.log ?? []) {
    if (seenLog.has(r)) continue;
    seenLog.add(r);
    if (r.kind === 'residentAbort') aborts[r.code] = (aborts[r.code] ?? 0) + 1;
    if (r.kind === 'agentError') aborts[`error:${r.code}`] = (aborts[`error:${r.code}`] ?? 0) + 1;
  }
  for (const a of Object.values(w.agents)) {
    for (const r of a.trace ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (r.kind) {
        if (r.ok) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        else failKind[`${r.kind}:${r.code}`] = (failKind[`${r.kind}:${r.code}`] ?? 0) + 1;
        if (r.ok && r.kind) actions += 1;
        if (r.layer === 'refused' || r.layer === 'rejected') actions += 0;
      }
    }
    // busy 分钟：进行中动作的 totalMin 已在执行时计入；这里按 trace 的 ok 动作时间计
  }
  // 每小时快照一次 busy/旅行（近似占用）
  for (const a of Object.values(w.agents)) {
    const b = s.actClock?.[a.id]?.busy;
    if (b) busyMinutes += 0; // 结束时会各自记；此处置 0 避免重复
  }
  hours.push({ hour, t: w.t, ms });
  const d = dayOf(w.t);
  if (d > 0 && w.t % 24 === 0) {
    // 日界刚过：记录这一天的状态
    const alive = livingResidents(w);
    const energy = alive.map((a) => Number((a.drives?.v?.energy ?? 0).toFixed(3)));
    const viab = alive.map((a) => Number((a.viab?.v ?? 0).toFixed(3)));
    const row = {
      day: d,
      population: alive.length,
      energy: { avg: avg(energy), min: energy.length ? Math.min(...energy) : null },
      viab: { avg: avg(viab), min: viab.length ? Math.min(...viab) : null },
      mealsToday: alive.map((a) => ({ id: a.id, mealDay: a.mealDay ?? null, loc: w.loc[a.id], busy: s.actClock?.[a.id]?.busy?.kind ?? null })),
      store: s.store,
      food: { ...(s.food ?? {}) },
      plots: (s.plots ?? []).map((p) => Number((p.growth ?? 0).toFixed(2))),
      water: Number((s.water ?? 0).toFixed(3)),
      soil: Number((s.soil ?? 0).toFixed(3)),
      births: s.births ?? 0,
      starveDays: s.starveDays ?? 0,
      deaths: (s.deaths ?? []).map((x) => `${x.id}/${x.cause}`),
      built: (s.buildings ?? []).map((b) => b.type),
      livestock: { ...(s.livestock ?? {}) },
      produce: { ...(s.produce ?? {}) },
      wildBerries: { ...(s.wildBerries ?? {}) },
      obs: dailyObs[d] ?? null,
      counters: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, {
        actions: a.counters?.actions ?? 0, refused: a.counters?.refused ?? 0,
        deliberation: a.counters?.deliberation ?? 0, habit: a.counters?.habit ?? 0,
      }])),
      agentErrors: s.agentErrors ?? 0,
    };
    hours.push({ dayRow: row });
  }
  if ((s.deaths ?? []).length > deaths.length) {
    for (const x of s.deaths.slice(deaths.length)) deaths.push({ ...x });
  }
}
function avg(xs) { return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null; }

const dayRows = hours.filter((x) => x.dayRow).map((x) => x.dayRow);
const out = {
  _说明: '1.1 正式钟生存定位：逐日食物/饥饿/进食/动作失败/死亡；不改规则。',
  at: new Date().toISOString(),
  mode, seed, days, options: { ...options, simClock: Boolean(options.simClock) },
  costTable: { eat: costFor('eat'), harvest: costFor('harvest'), plant: costFor('plant'), move_to: costFor('move_to'), build: costFor('build') },
  final: {
    population: livingResidents(w).length,
    ended: !!s.ended, reason: s.endReason ?? null,
    births: s.births ?? 0, deaths: (s.deaths ?? []).length,
    deathCauses: (s.deaths ?? []).reduce((acc, x) => { acc[x.cause] = (acc[x.cause] ?? 0) + 1; return acc; }, {}),
    store: s.store, food: { ...(s.food ?? {}) }, water: s.water, soil: s.soil,
    plots: s.plots, buildings: s.buildings, agentErrors: s.agentErrors ?? 0,
  },
  actions: { ok: byKind, failed: failKind, aborts },
  hours: hours.filter((x) => x.dayRow || x.hour % 24 === 0).map(({ dayRow, ...rest }) => rest),
  dayRows,
  deaths,
};
const file = join(OUT, `probe-${mode}-${seed}${rules !== 2 ? `-r${rules}` : ''}${step !== 60 ? `-step${step}` : ''}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ mode, seed, days, final: out.final, actions: out.actions, file }));
for (const r of dayRows) {
  if ([1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(r.day) || r.population === 0) {
    console.log(JSON.stringify({ day: r.day, pop: r.population, energy: r.energy, viab: r.viab, store: r.store, food: r.food, plots: r.plots, water: r.water, soil: r.soil, starve: r.starveDays, obs: r.obs }));
  }
}

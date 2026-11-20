#!/usr/bin/env node
// 定位用：旅行时长分布 + think 节拍，对比连续钟与旧每刻路径。
//   node scripts/v11-think-probe.mjs --seed 7 --days 5 [--legacy]
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { FORMAL_OPTIONS } from '../life/balance-probe.mjs';
import { createSimClock } from '../life/sim-clock.mjs';

const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const seed = Number(arg('seed', 7)), days = Number(arg('days', 5));
const legacy = process.argv.includes('--legacy');
const options = { ...FORMAL_OPTIONS };
if (!legacy) {
  options.simTime = true;
  options.simClock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  options.minuteMetab = !process.argv.includes('--off');
}
const sp = createSurvPlay(seed, options);
const w = sp.world, s = w.survival;
const agents = () => Object.values(w.agents).filter((a) => !a.isPlayer && !a.dead);
const stepMin = legacy ? 60 : 1;
const iters = days * (legacy ? 24 : 1440);
const startMin = {};   // id -> game minute travel started
const travelDur = [];  // minutes
const travelTicks = [];
const byKind = {};
let thoughts = 0, actions = 0, agentMin = 0, travelMin = 0;
const last = {};
for (let i = 0; i < iters; i += 1) {
  await tickSurvPlay(sp, w.simClock ? { minutes: 1 } : undefined);
  const gm = i * stepMin + stepMin; // 已推进的游戏分钟
  const list = agents();
  agentMin += list.length * stepMin;
  for (const a of list) {
    const p = last[a.id] ??= { delib: a.counters.deliberation, actions: a.counters.actions };
    thoughts += a.counters.deliberation - p.delib;
    actions += a.counters.actions - p.actions;
    p.delib = a.counters.deliberation; p.actions = a.counters.actions;
    const tr = s.districtTravel?.[a.id];
    if (tr) {
      travelMin += stepMin;
      startMin[a.id] ??= { gm, arrive: tr.arrive, from: tr.from, to: tr.to, len: tr.length, kind: tr.kind };
    } else if (startMin[a.id]) {
      const row = startMin[a.id];
      travelDur.push(gm - row.gm);
      travelTicks.push(row.arrive - Math.floor(row.gm / 60));
      delete startMin[a.id];
    }
  }
}
// 统计
const hist = (xs) => {
  const out = {};
  for (const x of xs) { const b = x <= 60 ? '<=1h' : x <= 120 ? '1-2h' : x <= 240 ? '2-4h' : x <= 480 ? '4-8h' : '>8h'; out[b] = (out[b] ?? 0) + 1; }
  return out;
};
const avg = (xs) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)) : null);
const agentsNow = agentMin / (iters * stepMin);
console.log(JSON.stringify({
  mode: legacy ? 'legacy' : (options.minuteMetab ? 'on' : 'off'), seed, days,
  thoughtsPerAgentDay: Number((thoughts / days / agentsNow).toFixed(1)),
  actionsPerAgentDay: Number((actions / days / agentsNow).toFixed(1)),
  travelShare: Number((travelMin / agentMin).toFixed(3)),
  completedTrips: travelDur.length,
  tripMinAvg: avg(travelDur), tripMinMax: travelDur.length ? Math.max(...travelDur) : null,
  tripHourHist: hist(travelDur),
  tripTicksAvg: avg(travelTicks),
  ongoingAtEnd: Object.keys(startMin).length,
}));

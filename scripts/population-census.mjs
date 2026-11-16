#!/usr/bin/env node
// V7.1 §6：代际因果链逐日统计（相遇 → 婚姻 → 住房 → 生育 → 成长 → 死亡）。
// 只读世界、零联网、不写 data/。
import { CURRENT_EVENT_RULES } from '../life/rng.mjs';
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { birthHomeStatus, residentStage } from '../life/households.mjs';
import { livingResidents } from '../life/viability.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const seeds = (process.argv[2] ?? '7,13,29').split(',').map(Number);
const days = Number(process.argv[3] ?? 100);
const DAY = 24;

const runs = [];
for (const seed of seeds) {
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  const series = [];
  const events = [];
  let prevSpouses = new Set(Object.keys(w.survival.households?.spouses ?? {}).filter((id) => w.survival.households.spouses[id]));
  let prevBirths = w.survival.births ?? 0;
  let prevDeaths = (w.survival.deaths ?? []).length;

  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < DAY; i += 1) await tickSurvPlay(sp, { now: Date.now() });
    if (w.survival.ended) break;
    const alive = Object.values(w.agents).filter((a) => !a.dead && !a.isPlayer);
    const adults = alive.filter((a) => residentStage(w, a.id) === 'adult');
    const males = adults.filter((a) => w.sex[a.id] === 'M').length;
    const females = adults.filter((a) => w.sex[a.id] === 'F').length;
    const h = w.survival.households ?? {};
    const couples = Object.entries(h.spouses ?? {}).filter(([a, b]) => a < b);
    const singles = adults.filter((a) => !h.spouses[a.id]).length;
    // 相遇机会：同日同屋的异性单身对
    let meetOpp = 0;
    for (let i = 0; i < adults.length; i += 1) {
      for (let j = i + 1; j < adults.length; j += 1) {
        const a = adults[i], b = adults[j];
        if (h.spouses[a.id] || h.spouses[b.id]) continue;
        if (w.sex[a.id] === w.sex[b.id]) continue;
        if (w.loc[a.id] === w.loc[b.id]) meetOpp += 1;
      }
    }
    // 生育条件：已婚无子的夫妻，卡在哪个 reason
    const reasons = {};
    for (const [a, b] of couples) {
      const kids = Object.keys(h.residents).filter((id) => h.residents[id].parents?.includes(a) && h.residents[id].parents?.includes(b));
      if (kids.length) continue;
      const st = birthHomeStatus(w, a, b);
      const key = st.ok ? 'ok' : (st.reason ?? 'unknown');
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    const births = w.survival.births ?? 0;
    const deaths = (w.survival.deaths ?? []);
    if (births > prevBirths) events.push({ day: d + 1, kind: 'birth', n: births - prevBirths });
    if (deaths.length > prevDeaths) events.push({ day: d + 1, kind: 'death', n: deaths.length - prevDeaths, causes: deaths.slice(prevDeaths).map((x) => x.cause ?? '?') });
    const nowSpouses = new Set(Object.keys(h.spouses ?? {}).filter((id) => h.spouses[id]));
    const newPairs = [...nowSpouses].filter((id) => !prevSpouses.has(id));
    if (newPairs.length) events.push({ day: d + 1, kind: 'marriage', ids: newPairs });
    prevSpouses = nowSpouses; prevBirths = births; prevDeaths = deaths.length;

    series.push({ day: d + 1, living: alive.length, adults: adults.length, males, females, singles, couples: couples.length, meetOpp, store: w.survival.store, homes: new Set(Object.values(w.housing ?? {})).size, reasons, births, deaths: deaths.length });
  }
  const end = series[series.length - 1] ?? {};
  runs.push({
    seed,
    days: series.length,
    ended: !!w.survival.ended,
    endReason: w.survival.endReason ?? null,
    firstDeathDay: events.find((e) => e.kind === 'death')?.day ?? null,
    events,
    last: end,
    deathCauses: (w.survival.deaths ?? []).reduce((m, d) => { m[d.cause ?? '?'] = (m[d.cause ?? '?'] ?? 0) + 1; return m; }, {}),
    marriages: (w.survival.households?.marriages ?? []).length,
    series,
  });
}

console.log(JSON.stringify({ days, seeds, runs }, null, 2));

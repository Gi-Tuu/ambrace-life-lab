// V7.4.1 研究态：M3 grace 0/6/12 × seeds ×30 日。只读观测，不改默认。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { DAY_TICKS } from './clock.mjs';
import { isAlive } from './body.mjs';
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function run(seed, days, grace) {
  process.env.M3_GRACE = String(grace);
  const sp = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const w = sp.world;
  const starts = new Map(); const events = []; const waits = [];
  for (const a of Object.values(w.agents)) if (!a.isPlayer) starts.set(a.id, { tick: null, goal: null });
  const choose = new Map();
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    const orig = a.m3Choose.bind(a);
    a.m3Choose = (world, paths) => {
      const before = a.m3Last?.goal ?? null;
      const out = orig(world, paths);
      const after = a.m3Last?.goal ?? null;
      const st = starts.get(a.id);
      if (!before && after) { st.tick = w.t; st.goal = after; events.push({ tick: w.t, actor: a.id, type: 'start', goal: after }); }
      if (before && after && before !== after) events.push({ tick: w.t, actor: a.id, type: 'switch', from: before, to: after });
      if (before && !after && (a.m3Last?.interrupted)) {
        events.push({ tick: w.t, actor: a.id, type: 'abort', code: a.m3Last.interrupted, goal: before,
          duration: st.tick != null ? w.t - st.tick : null, waited: a.m3Last?.waited ?? null });
        st.tick = null; st.goal = null;
      }
      if (a.m3Last?.waited > 0) waits.push(a.m3Last.waited);
      return out;
    };
  }
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(sp);
  const control = createSurvPlay(seed, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  for (let i = 0; i < days * DAY_TICKS; i += 1) await tickSurvPlay(control);
  const book = w.survival?.actionLedger?.resident ?? {};
  const labor = Object.values(book.minutes ?? {}).reduce((a, n) => a + Number(n), 0);
  const populations = Object.values(w.agents).filter((a) => !a.isPlayer && isAlive(a)).length;
  const counts = events.reduce((a, e) => { const k = e.type === 'abort' ? e.code : e.type; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return { seed, days, grace, population: populations,
    births: Array.isArray(w.survival?.births) ? w.survival.births.length : (w.survival?.births ?? 0),
    deaths: Array.isArray(w.survival?.deaths) ? w.survival.deaths.length : (w.survival?.deaths ?? 0),
    store: w.survival?.store ?? null, labor, errors: w.survival?.agentErrors ?? 0,
    talk: (w.survival?.actionLedger?.resident?.success?.talk ?? 0),
    starts: events.filter((e) => e.type === 'start').length, switches: events.filter((e) => e.type === 'switch').length,
    aborts: events.filter((e) => e.type === 'abort').length, counts,
    waits: { n: waits.length, max: waits.length ? Math.max(...waits) : 0,
      mean: waits.length ? Number((waits.reduce((a, n) => a + n, 0) / waits.length).toFixed(2)) : 0 },
    nonPerturbation: { observed: sha(dumpSurv(sp)), control: sha(dumpSurv(control)), equal: sha(dumpSurv(sp)) === sha(dumpSurv(control)) },
    events: events.slice(0, 50) };
}

if (process.argv[1] && process.argv[1].endsWith('v741-grace-matrix.mjs')) {
  const days = Number(process.argv[2] ?? 30);
  const groups = [];
  for (const grace of [0, 6, 12]) for (const seed of [7, 13, 29]) groups.push(await run(seed, days, grace));
  mkdirSync('evidence/v741', { recursive: true });
  writeFileSync(`evidence/v741/m3-grace-${days}d.json`, JSON.stringify({ generatedAt: new Date().toISOString(), days, groups }, null, 2));
  console.log(JSON.stringify(groups.map((g) => ({ seed: g.seed, grace: g.grace, pop: g.population, starts: g.starts,
    aborts: g.aborts, counts: g.counts, waits: g.waits, talk: g.talk, errors: g.errors, hash: g.nonPerturbation.equal })), null, 2));
}


// V7.3.2 第三批：30/100/200 日长期表（当前参数；玩家闲置夹具，自然演化，不选种子/不改结局）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { runLong } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const SEEDS = [7, 13, 29, 41, 53];
const DAYS = [30, 100, 200];
const rows = [];
for (const seed of SEEDS) {
  const r = await runLong(seed, 200, { eventRulesVersion: CURRENT_EVENT_RULES, checkpoints: DAYS, options: FORMAL_OPTIONS });
  for (const day of DAYS) {
    const snap = day === 200 ? r.final : r.milestones[day];
    if (!snap) continue;
    const st = snap.stats?.resident ?? {};
    rows.push({
      seed, day, natural: true, playerIdle: true, options: 'FORMAL_OPTIONS + B120 lifecycle',
      population: snap.population, stages: snap.stages,
      births: snap.births, deaths: snap.deaths, deathCauses: snap.deathCauses,
      playerAlive: snap.playerAlive, playerViab: snap.playerViab,
      laborMinutes: snap.laborMinutes, actionMinutes: snap.actionMinutes,
      actions: { attempt: st.attempt ?? 0, success: st.success ?? 0, aborted: st.aborted ?? 0, cancelled: st.cancelled ?? 0, refused: st.refused ?? 0, laborRate: st.laborRate ?? null },
      busy: null,
      energy: snap.energy, viability: snap.viability,
      store: snap.store, storeCap: snap.storeCap, inv: snap.inv, materials: snap.materials,
      agri: snap.agri, resStock: snap.resStock, produce: snap.produce, livestock: snap.livestock,
      ended: snap.ended, failed: snap.failed, endReason: snap.endReason,
    });
  }
  console.log(JSON.stringify({ seed, days: DAYS, pop: DAYS.map((d) => r.milestones[d]?.population), births: r.final.births,
    deaths: r.final.deaths, labor: r.final.laborMinutes, actions: rows.filter((x) => x.seed === seed).at(-1)?.actions }));
}
mkdirSync('docs', { recursive: true });
const out = {
  generatedAt: new Date().toISOString(), seeds: SEEDS, days: DAYS,
  config: { options: FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, player: 'idle fixture', lifecycle: 'B120 defaults', seedsFixed: true },
  naturalEvolution: true, artificialSettings: ['player idle (no actions)', 'seed list chosen for coverage, not for outcomes'],
  rows,
  summary: {
    pop100: rows.filter((x) => x.day === 100).map((x) => [x.seed, x.population]),
    pop200: rows.filter((x) => x.day === 200).map((x) => [x.seed, x.population]),
    extinct200: rows.filter((x) => x.day === 200 && x.ended).length,
    births200: rows.filter((x) => x.day === 200).map((x) => [x.seed, x.births]),
    labor100: rows.filter((x) => x.day === 100).map((x) => [x.seed, x.laborMinutes]),
  },
};
writeFileSync('docs/long-table-v732.json', JSON.stringify(out, null, 2));
function sum(o) { return Object.values(o ?? {}).reduce((a, n) => a + n, 0); }



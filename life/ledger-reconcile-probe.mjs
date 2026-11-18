// V7.3.4 E：生成逐实例对账证据（只读索引，不改存档）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { reconcile, indexActions } from './ledger-reconcile.mjs';
import { measureIdle } from './idle-probe.mjs';

const r = await measureIdle(7, 3);
const book = r.ledgerBook ?? {};
const observed = {};
for (const e of r.events ?? []) {
  if (!['completed', 'failed', 'aborted', 'cancelled'].includes(e.status)) continue;
  observed[e.kind] ??= { minutes: 0, energy: 0, n: 0 };
  observed[e.kind].minutes += Number(e.actualMinutes ?? 0);
  observed[e.kind].energy += Number(e.actualEnergy ?? 0);
  observed[e.kind].n += 1;
}
const mismatches = [];
for (const [kind, row] of Object.entries(observed)) {
  const ledgerMin = Number(book.minutes?.[kind] ?? 0);
  const ledgerEnergy = Number(book.energy?.[kind] ?? 0);
  if (Math.abs(row.minutes - ledgerMin) > 1e-6 || Math.abs(row.energy - ledgerEnergy) > 1e-6) {
    mismatches.push({ type: 'AGGREGATE_MISMATCH', kind, observer: row, ledger: { minutes: ledgerMin, energy: ledgerEnergy } });
  }
}
const inst = indexActions(r.events ?? []);
const out = {
  generatedAt: new Date().toISOString(), seed: 7, days: 3, ticks: r.ticksRun,
  instances: inst.map.size, anomalyCount: inst.anomalies.length,
  anomalies: inst.anomalies.slice(0, 200),
  observedByKind: observed, ledgerByKind: { minutes: book.minutes ?? {}, energy: book.energy ?? {} },
  sync: { ledgerSync: book.sync ?? 0, observerSync: (r.events ?? []).filter((e) => e.kind === 'player_sync').length },
  aggregateMismatches: mismatches,
  counts: { instances: inst.map.size, instanceAnomalies: inst.anomalies.length,
    duplicateFinal: inst.anomalies.filter((x) => x.type === 'DUPLICATE_FINAL').length,
    beforeStart: inst.anomalies.filter((x) => x.type === 'COMPLETE_BEFORE_START').length,
    aggregateMismatches: mismatches.length },
};
mkdirSync('evidence/v734', { recursive: true });
writeFileSync('evidence/v734/ledger-reconcile.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.counts));

#!/usr/bin/env node
// 阶段 5：种子 7 真实风暴切片（本地 A/B，无模型、无伪造事件）。
// 从种子档推进到预警前一刻，再以同一份快照开 A(C2)/B(C2-neg)；
// 逐刻录帧与 eventJournal（storm_warning / storm_impact），并记录两侧维修与扣料。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadSurv, tickSurvPlay } from '../life/survplay.mjs';
import { stormOn } from '../life/worldstate.mjs';
import { survivalOptions } from '../life/host.mjs';
import { DAY_TICKS } from '../life/clock.mjs';
import { createReplay, recordReplayFrame, replayRange } from '../life/replay-history.mjs';

const repo = resolve(process.argv[2] ?? process.cwd());
const outDir = resolve(process.argv[3] ?? process.cwd());
const seedFile = join(repo, 'seed', 'world.json');
const source = JSON.parse(readFileSync(seedFile, 'utf8'));
const raw = source.survival;
const seed = source.seed ?? 7;
const hash = (b) => createHash('sha256').update(b).digest('hex');

const stormDay = Array.from({ length: 120 }, (_, d) => d).find((d) => d * DAY_TICKS > raw.t && stormOn(d, raw.survival.lastStormDay, raw.seed));
const onset = stormDay * DAY_TICKS, warning = onset - DAY_TICKS, pre = warning - 1;
const end = onset + 2 * DAY_TICKS; // 1608 + 48 = 1656（覆盖 1618…1640）
const options = { ...survivalOptions(), adoptArchivedRules: true, upgradeLegacyEventRules: true, gameRules: true, independentWorld: true }; // 事件日志只在 gameRules 下记

// 1) 推进到预警前一刻（本地替身；不调模型）
const base = loadSurv(structuredClone(raw), seed, options);
for (let i = 0; base.world.t < pre; i += 1) await tickSurvPlay(base, { now: (base.world.t + 1) * 1000 });
if (base.world.t !== pre) throw new Error(`推进刻度不对：${base.world.t} != ${pre}`);
const snapshot = structuredClone((await import('../life/survplay.mjs')).dumpSurv(base));

// 2) 同一快照开 A/B
const A = loadSurv(structuredClone(snapshot), seed, { ...options, residentCondition: 'C2' });
const B = loadSurv(structuredClone(snapshot), seed, { ...options, residentCondition: 'C2-neg' });

const card = (sp) => {
  const w = sp.world;
  return {
    side: w.residentCondition === 'C2' ? 'A' : 'B', t: w.t,
    store: w.survival?.store ?? null,
    buildings: (w.survival?.buildings ?? []).map((b) => ({ type: b.type, loc: b.loc, integrity: b.integrity })),
    agents: Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({ id: a.id, name: a.name, loc: w.loc[a.id], energy: Number(a.drives.v.energy.toFixed(2)), viab: Number(a.viab.v.toFixed(2)), dead: !!a.dead })),
  };
};
const sideInfo = {
  A: { repairs: [], spent: [], repairsBy: {} },
  B: { repairs: [], spent: [], repairsBy: {} },
};
function attach(sp, key) {
  const w = sp.world;
  w.observeProduction = (channel, resource, amount) => {
    if (channel === 'materialSpent' && /repair/i.test(String(resource))) sideInfo[key].spent.push({ t: w.t, resource, amount });
  };
  return (agent, trace) => {
    for (const row of trace) {
      if (row.t !== w.t) continue;
      if (row.kind === 'repair' && row.ok) {
        sideInfo[key].repairs.push({ t: w.t, who: agent.name, id: agent.id, action: row.action ?? null });
        sideInfo[key].repairsBy[agent.name] = (sideInfo[key].repairsBy[agent.name] ?? 0) + 1;
      }
    }
  };
}
const onA = attach(A, 'A'), onB = attach(B, 'B');
const replay = createReplay(0, end - warning + 8);
const events = [];
for (let t = warning; t <= end; t += 1) {
  await tickSurvPlay(A, { now: t * 1000, onResidentAction: onA });
  await tickSurvPlay(B, { now: t * 1000, onResidentAction: onB });
  const at = [...(A.world.survival?.eventJournal?.rows ?? []), ...(B.world.survival?.eventJournal?.rows ?? [])]
    .filter((e) => e.t === t).map((e, i) => ({ ...e, side: e.side ?? (A.world.survival.eventJournal.rows.includes(e) ? 'A' : 'B'), seq: i }));
  events.push(...at);
  recordReplayFrame(replay, { t, A: card(A), B: card(B), events: at });
}
const byTick = (list) => Object.fromEntries([...new Set(list.map((e) => e.t))].sort((a, b) => a - b).map((t) => [t, list.filter((e) => e.t === t)]));
const range = replayRange(replay, { from: warning, to: end });
const out = {
  generatedAt: new Date().toISOString(), seed, stormDay, warning, onset, end, preTick: pre,
  snapshotSha256: hash(JSON.stringify(snapshot)), frameBytes: JSON.stringify(range.frames).length,
  frames: range.frames, events, eventTicks: byTick(events),
  sides: {
    A: { repairs: sideInfo.A.repairs, repairsBy: sideInfo.A.repairsBy, spent: sideInfo.A.spent },
    B: { repairs: sideInfo.B.repairs, repairsBy: sideInfo.B.repairsBy, spent: sideInfo.B.spent },
  },
  checks: {
    warningEventTick: events.find((e) => e.kind === 'storm_warning')?.t ?? null,
    impactEventTick: events.find((e) => e.kind === 'storm_impact')?.t ?? null,
    eventKinds: [...new Set(events.map((e) => e.kind))],
  },
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'storm-slice.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ warning, onset, end, frames: range.frames.length, frameBytes: out.frameBytes, checks: out.checks, A: { repairs: sideInfo.A.repairs.length, by: sideInfo.A.repairsBy }, B: { repairs: sideInfo.B.repairs.length, by: sideInfo.B.repairsBy } }, null, 2));


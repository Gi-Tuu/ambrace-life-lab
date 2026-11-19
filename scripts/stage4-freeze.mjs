#!/usr/bin/env node
// 阶段 4 冻结：跑正式游戏态世界，把**真实发生的审议询问**的决策前输入冻结成 JSONL。
// 不复用生产提示词之外的第二套构造：提示词直接调 host.deliberationPrompt（original/compact 复用同一 args）。
// 用法：node scripts/stage4-freeze.mjs [seeds] [days] [cap] [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { survivalOptions, deliberationPrompt, buildDeliberationPrompt } from '../life/host.mjs';

const seeds = (process.argv[2] ?? '7,13,29,41,53').split(',').map(Number);
const days = Number(process.argv[3] ?? 20);
const cap = Number(process.argv[4] ?? 500);
const outDir = process.argv[5] ?? new URL('../output-stage4/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DAY = 24;
const rows = [];

const project = (world, agent) => {
  const s = world.survival ?? null;
  return {
    t: world.t,
    loc: world.loc[agent.id],
    survival: s ? {
      store: s.store, water: Number(s.water.toFixed(2)),
      wood: world.pinv?.[agent.id]?.wood ?? 0, stone: world.pinv?.[agent.id]?.stone ?? 0,
      food: s.food ? { ...s.food } : null,
    } : null,
    pantry: world.pantry,
    housing: world.housing?.[agent.id] ?? null,
    buildings: (s?.buildings ?? []).map((b) => ({ type: b.type, integrity: b.integrity })),
    sites: (s?.sites ?? []).map((x) => ({ type: x.type, progress: x.progress })),
  };
};

for (const seed of seeds) {
  const tap = (args) => {
    if (rows.length >= cap) return null;
    const ids = (args.scored ?? []).map((x) => x.id);
    if (!ids.length) return null;
    const sample = {
      id: `${seed}:${args.world.t}:${args.agent.id}:${rows.length}`,
      seed, t: args.world.t,
      agent: args.agent.id, name: args.agent.name, archetype: args.agent.traits.archetype,
      loc: args.world.loc[args.agent.id],
      trigger: String(args.trigger ?? ''),
      rejected: args.rejected ? { from: args.rejected.from ?? null, code: args.rejected.code ?? null, why: args.rejected.why ?? null } : null,
      memories: (args.memories ?? []).map((m) => ({ kind: m.kind ?? null, sim: Number.isFinite(m.sim) ? Number(m.sim.toFixed(4)) : null })),
      candidateIds: ids,
      labels: Object.fromEntries((args.scored ?? []).map((x) => [x.id, x.act?.label ?? x.id])),
      daySummary: args.daySummary ?? null,
      projection: project(args.world, args.agent),
      promptOriginal: deliberationPrompt(args, 'original'),
      promptCompact: deliberationPrompt(args, 'compact'),
    };
    // 负控一的自证点：original 必须逐字等于生产构造器。
    if (sample.promptOriginal !== buildDeliberationPrompt(args)) throw new Error('original 提示词与生产构造器不一致');
    rows.push(sample);
    return null;
  };
  const sp = createSurvPlay(seed, { ...survivalOptions(), gameRules: true, independentWorld: true, deliberator: tap });
  for (let i = 0; i < DAY * days && rows.length < cap; i += 1) await tickSurvPlay(sp, { now: Date.now() });
  const asked = Object.values(sp.world.agents).filter((a) => !a.isPlayer).map((a) => `${a.id}:${a.counters.asked ?? 0}`).join(' ');
  console.log(`seed ${seed}: 冻结累计 ${rows.length} 条（刻 ${sp.world.t}）；asked ${asked}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'freeze.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const byTrigger = {};
const kinds = {};
for (const r of rows) {
  byTrigger[r.trigger] = (byTrigger[r.trigger] ?? 0) + 1;
}
const flags = {
  rejected: rows.filter((r) => r.rejected).length,
  noMemory: rows.filter((r) => !r.memories.length).length,
  shortfall: rows.filter((r) => (r.projection.survival?.store ?? 99) <= 3).length,
  repair: rows.filter((r) => r.candidateIds.some((id) => id.startsWith('repair'))).length,
  housing: rows.filter((r) => r.candidateIds.some((id) => /house|home|build/.test(id))).length,
  talk: rows.filter((r) => r.candidateIds.some((id) => /talk|request|coop/.test(id))).length,
  work: rows.filter((r) => r.candidateIds.some((id) => /gather|harvest|plant|build/.test(id))).length,
};
console.log('触发分布', JSON.stringify(byTrigger));
console.log('覆盖计数', JSON.stringify(flags));
console.log(`输出 ${rows.length} 条 ⇒ ${join(outDir, 'freeze.jsonl')}`);

#!/usr/bin/env node
// DM-1 采集端：跑正式游戏态世界，把**真实发生过的审议询问**连生产提示词一起导出，交给节点上的各台引擎重放。
// 关键约束：提示词只来自 life/host.mjs 的 buildDeliberationPrompt —— 本脚本不许有自己的副本，
// 否则"影子对照"量的就是两套问题（这条是结构性的：删掉 import 就跑不出采集）。
// tap 返回 null ⇒ 引擎按"模型不可用"退回确定性抽样，世界轨迹与无模型时相同：零额外成本、零行为改变。
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { survivalOptions, buildDeliberationPrompt } from '../life/host.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const seeds = (process.argv[2] ?? '7,13,29').split(',').map(Number);
const days = Number(process.argv[3] ?? 30);
const cap = Number(process.argv[4] ?? 240);
const DAY = 24;
const out = [];

for (const seed of seeds) {
  const tap = ({ agent, scored, world, rejected, trigger, memories, daySummary }) => {
    if (out.length >= cap) return null;
    const ids = (scored ?? []).map((s) => s.id);
    if (!ids.length) return null;
    const prompt = buildDeliberationPrompt({ agent, scored, world, rejected, memories, trigger, daySummary });
    if (!prompt.includes('可做的事')) { out.skippedShape = (out.skippedShape ?? 0) + 1; return null; }
    out.push({
      seed, t: world.t, agent: agent.id, name: agent.name,
      trigger: String(trigger ?? '').slice(0, 70),
      rulesTop1: ids[0], candidateIds: ids, candidateCount: ids.length, prompt,
    });
    return null;
  };
  const sp = createSurvPlay(seed, { ...survivalOptions(), gameRules: true, independentWorld: true, deliberator: tap });
  const w = sp.world;
  for (let i = 0; i < DAY * days && out.length < cap; i++) await tickSurvPlay(sp, { now: Date.now() });
  const c = Object.values(w.agents).filter((a) => !a.isPlayer)
    .map((a) => `${a.id} asked=${a.counters.asked ?? 0} skipped=${a.counters.skipped ?? 0} trig=${a.counters.triggered ?? 0} fallback=${a.counters.fallback ?? 0}`);
  console.log(`seed ${seed}: 采集累计 ${out.length} 条（刻 ${w.t}，居民 ${Object.values(w.agents).filter((a) => !a.dead && !a.isPlayer).length}）| ${c.join(' | ')}`);
}

mkdirSync(new URL('../docs/evidence/', import.meta.url), { recursive: true });
const file = new URL(`../docs/evidence/shadow-asks-${seeds.join('_')}-d${days}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1));
const uniq = new Map();
for (const x of out) uniq.set(x.rulesTop1, (uniq.get(x.rulesTop1) ?? 0) + 1);
console.log(`导出 ${out.length} 条 ⇒ ${file.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
console.log(`规则层 top-1 分布（${uniq.size} 种）：`, [...uniq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join(' '));
console.log(`候选数中位：${[...out.map((x) => x.candidateCount)].sort((a, b) => a - b)[Math.floor(out.length / 2)] ?? '-'} | 提示词字数中位：${out.map((x) => x.prompt.length).sort((a, b) => a - b)[Math.floor(out.length / 2)] ?? '-'}`);

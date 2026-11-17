// 阶段 4：审议输入边界的上下文压缩候选（默认关闭）。
//
// 边界约定：
// - 本模块只负责"把同一份决策前输入渲染成更短的提示词"，不改变决策、不删候选、不改协议字段。
// - 原版构造器仍是唯一默认路径；只有 MODEL_CONTEXT=compact 时才由 host 选择本模块。
// - 旧记录缺字段（没有 kind/sim 之外的元数据）走可解释降级：保持原顺序、只做去重与上限。
// - 记忆按 kind 去重（同 kind 保留相似度最高的一条）并按相似度取前 MEMORY_CAP 条；
//   触发原因、关键库存/危险、候选 ID 与顺序、驳回理由全部原样保留。

export const MEMORY_CAP = 6;
export const COMPACT_ENV = 'MODEL_CONTEXT';
export const compactEnabled = (env = process.env) => env?.[COMPACT_ENV] === 'compact';

// 旧记录/异常输入的可解释降级：没有 sim 视为 0，没有 kind 用 'memory'，保持原序。
function memoriesOf(memories) {
  const rows = (Array.isArray(memories) ? memories : []).map((m) => ({
    kind: String(m?.kind ?? 'memory'),
    sim: Number.isFinite(m?.sim) ? m.sim : 0,
  }));
  const best = new Map();
  rows.forEach((row, index) => {
    const prev = best.get(row.kind);
    if (!prev || row.sim > prev.sim) best.set(row.kind, { ...row, index });
  });
  return [...best.values()].sort((a, b) => b.sim - a.sim || a.index - b.index).slice(0, MEMORY_CAP);
}

function memoriesLine(memories) {
  const rows = memoriesOf(memories);
  return rows.length ? rows.map((m) => `${m.kind}(相似${m.sim})`).join('、') : '暂无';
}

const presentOf = (world, agent, here) => (world.occupancy?.[here] ?? [])
  .filter((x) => x !== agent.id && (world.survival || x !== 'p1'))
  .map((x) => world.agents?.[x]?.name ?? x);

// 与 host.buildDeliberationPrompt 的字段与顺序保持一致；差异只有三处：
// 记忆去重+上限、两段协议合并成一段、其余文本原样。
export function buildCompactDeliberationPrompt({ agent, scored, world, rejected, memories, trigger, daySummary, bands = {} }) {
  const here = world.loc[agent.id];
  const present = presentOf(world, agent, here);
  const dom = agent.drives.dominant();
  const lines = [
    `你是${agent.name}（${agent.traits.archetype}型）。第 ${world.t} 刻，你在${here}。`,
    `为什么现在问你：${trigger}`,
    `内部读数：${agent.bank.summary()}`,
    `此刻你最缺：${dom.label}（偏差 ${dom.e.toFixed(2)}，紧迫度 ${dom.urgency.toFixed(2)}）`,
    world.survival
      ? `生存营地：公共食物 ${world.survival.store} 份，水 ${world.survival.water.toFixed(2)}，个人木料 ${world.pinv?.[agent.id]?.wood ?? 0}、石料 ${world.pinv?.[agent.id]?.stone ?? 0}。在场的人：${present.join('、') || '没有'}`
      : `世界事实：公仓余 ${world.pantry} 份；你自己门口存着 ${world.stash[agent.id]} 份（你以为该有 ${world.expect[agent.id]} 份）；在场的人：${present.join('、') || '没有'}`,
    `你想起的事：${memoriesLine(memories)}`,
    daySummary ? `上一天的自己：${daySummary}` : '',
    '可做的事（只能选一项，id 照抄）：',
    ...[...scored].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => `- ${s.id} | ${s.act.label} | ${bands[s.id] ?? '同档'}`),
  ].filter(Boolean);
  if (rejected) lines.push(`你上次想做 ${rejected.from} 被驳回：${rejected.why}。这次换一个可行的。`);
  lines.push('只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过6字"}；若此刻有在场的人、你想顺带说一句，再加 "act"（request/offer/warn/inform/greet/accuse/thank/decline/refuse 之一）、"topic"（food/firewood/shelter/child/work/weather/boundary/trust 之一）、"text"（不超过28字）；不想说就省略这三项。');
  return lines.join(String.fromCharCode(10));
}

// 关键事实自检：这些字符串必须原样出现在提示词里（负控二的判据）。
export function missingCriticalFacts(prompt, sample) {
  const text = String(prompt ?? '');
  const missing = [];
  const need = (label, value) => { if (value !== null && value !== undefined && !text.includes(String(value))) missing.push(label); };
  need('tick', `第 ${sample.t} 刻`);
  need('loc', `你在${sample.loc}`);
  need('trigger', sample.trigger);
  if (sample.survival) {
    need('store', `公共食物 ${sample.survival.store} 份`);
    need('water', `水 ${Number(sample.survival.water).toFixed(2)}`);
    need('wood', `个人木料 ${sample.survival.wood}`);
    need('stone', `石料 ${sample.survival.stone}`);
  }
  if (sample.rejected) {
    need('rejected.from', sample.rejected.from);
    need('rejected.why', sample.rejected.why);
  }
  for (const id of sample.candidateIds ?? []) need(`candidate:${id}`, `- ${id} |`);
  for (const key of ['"id"', '"reason"', '"act"', '"topic"', '"text"']) need(`protocol:${key}`, key);
  return missing;
}

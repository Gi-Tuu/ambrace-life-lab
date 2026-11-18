// V7.3.2 调度公平最小原型：每刻每居民最多 1 次 decideOn，按久闲优先轮转，预算=min(cap, 存活居民数)。
// 只包裹审议入口；反射/习惯/世界规则不变。默认关（FAIR_SCHED=1 才启用），研究态永不启用。
export const FAIR_ENV = 'FAIR_SCHED';
export const FAIR_CAP_ENV = 'FAIR_DECISION_CAP';
export const DEFAULT_FAIR_CAP = 6;

export function fairEnabled(env = process.env) {
  return env?.[FAIR_ENV] === '1';
}
export function fairCap(env = process.env) {
  const n = Number(env?.[FAIR_CAP_ENV] ?? DEFAULT_FAIR_CAP);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_FAIR_CAP;
}
export function fairBudget(population, cap = DEFAULT_FAIR_CAP) {
  return Math.max(1, Math.min(cap, Math.max(0, Math.floor(population))));
}

export function createFairState(world, { cap = fairCap() } = {}) {
  world.fairSched = {
    t: null, cursor: 0, cap, allowed: new Set(), last: {},
    stats: { ticks: 0, allowed: 0, calls: 0, blocked: 0, peakAllowed: 0, peakCalls: 0, budget: 0 },
  };
  return world.fairSched;
}

function prepare(world, fs) {
  const ids = Object.values(world.agents)
    .filter((a) => !a.isPlayer && !a.dead)
    .map((a) => a.id)
    .sort((a, b) => (fs.last[a] ?? -1) - (fs.last[b] ?? -1) || a.localeCompare(b));
  if (!ids.length) { fs.allowed = new Set(); return; }
  const budget = fairBudget(ids.length, fs.cap);
  // 排序已保证久闲者在前；预算取前 N，即“轮转”由 lastDecisionTick 自然完成。
  const picked = new Set(ids.slice(0, budget));
  fs.allowed = picked;
  fs.cursor = (fs.cursor + budget) % ids.length;
  fs.stats.ticks += 1;
  fs.stats.callsThisTick = 0;
  fs.stats.budget = budget;
  fs.stats.allowed += picked.size;
  fs.stats.peakAllowed = Math.max(fs.stats.peakAllowed, picked.size);
}

// 包装一个居民的 decideOn。未获额度 / 本刻已决策 ⇒ 返回 null（本刻不产生审议决策，不扣时间）。
export function installFairGuard(world, agent, fs = world.fairSched) {
  if (!fs || typeof agent?.decideOn !== 'function') return;
  const original = agent.decideOn.bind(agent);
  agent.decideOn = async (...args) => {
    if (fs.t !== world.t) { fs.t = world.t; prepare(world, fs); }
    if (fs.last[agent.id] === world.t) { fs.stats.blocked += 1; return null; }
    if (!fs.allowed.has(agent.id)) { fs.stats.blocked += 1; return null; }
    fs.last[agent.id] = world.t;
    fs.stats.calls += 1;
    fs.stats.peakCalls = Math.max(fs.stats.peakCalls, fs.stats.callsThisTick = (fs.stats.callsThisTick ?? 0) + 1);
    return original(...args);
  };
}

export function installFairSched(world, env = process.env) {
  if (!fairEnabled(env) || world?.independentWorld !== true || world?.gameRules !== true) return null;
  const fs = createFairState(world, { cap: fairCap(env) });
  for (const a of Object.values(world.agents)) if (!a.isPlayer) installFairGuard(world, a, fs);
  return fs;
}


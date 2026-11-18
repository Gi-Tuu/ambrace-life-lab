// V7.3.2 全链路调度轮转原型：
// “一次完整决策机会” = 该居民本刻的 agent.tick() 被调用一次（反射/习惯/审议及其链都在 tick 内）。
// 每刻预算 = min(cap, 存活居民数)；按 lastOpportunityTick 久闲优先取前 N；每人每刻≤1 次机会；
// tick 之外的追加 decideOn（决策链）在公平模式下被挡住，保证“一次机会只对应一次完整决策”。
// 默认关（FAIR_SCHED=1 才启用），研究态永不启用；生理代谢仍在 survplay 的 drives/viab 循环，不动世界规则。
export const FAIR_ENV = 'FAIR_SCHED';
export const FAIR_CAP_ENV = 'FAIR_DECISION_CAP';
export const DEFAULT_FAIR_CAP = 8;

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
    t: null, cap, allowed: new Set(), last: {}, debt: {}, denied: {}, inTick: false,
    stats: {
      ticks: 0, allowed: 0, peakAllowed: 0, opportunities: 0, blockedTicks: 0,
      blockedChains: 0, calls: 0, peakCalls: 0, budget: 0, eligible: 0, debtMax: 0,
    },
  };
  return world.fairSched;
}

function prepare(world, fs) {
  const eligible = [];
  fs.denied = {};
  for (const a of Object.values(world.agents)) {
    if (a.isPlayer || a.dead) continue;
    const c = world.survival?.actClock?.[a.id];
    const busy = Boolean(c?.busy);
    const tickLeft = c ? 60 - (c.tick?.usedMin ?? 0) : 60;
    const energy = a.drives?.v?.energy ?? 1;
    if (busy) { fs.denied[a.id] = 'busy'; continue; }
    if (tickLeft <= 0) { fs.denied[a.id] = 'time'; continue; }
    if (energy <= 0.01) { fs.denied[a.id] = 'energy'; continue; }
    eligible.push(a.id);
  }
  fs.stats.ticks += 1;
  fs.stats.callsThisTick = 0;
  fs.stats.eligible = eligible.length;
  if (!eligible.length) { fs.allowed = new Set(); return; }
  const budget = fairBudget(eligible.length, fs.cap);
  const ranked = [...eligible].sort((a, b) => {
    const d = (fs.debt[b] ?? 0) - (fs.debt[a] ?? 0); // 欠账多者优先
    if (d) return d;
    const l = (fs.last[a] ?? -1) - (fs.last[b] ?? -1); // 久闲优先
    return l || a.localeCompare(b);
  });
  fs.allowed = new Set(ranked.slice(0, budget));
  for (const id of eligible) {
    if (fs.allowed.has(id)) fs.debt[id] = 0;
    else { fs.debt[id] = (fs.debt[id] ?? 0) + 1; fs.denied[id] = 'budget'; }
  }
  fs.stats.budget = budget;
  fs.stats.allowed += fs.allowed.size;
  fs.stats.peakAllowed = Math.max(fs.stats.peakAllowed, fs.allowed.size);
  fs.stats.debtMax = Math.max(...Object.values(fs.debt));
}

export function installFairGuard(world, agent, fs = world.fairSched) {
  if (!fs || typeof agent?.tick !== 'function') return;
  const originalTick = agent.tick.bind(agent);
  agent.tick = async (...args) => {
    if (fs.t !== world.t) { fs.t = world.t; prepare(world, fs); }
    if (fs.last[agent.id] === world.t) { fs.stats.blockedTicks += 1; return null; }
    if (!fs.allowed.has(agent.id)) { fs.stats.blockedTicks += 1; return null; }
    fs.last[agent.id] = world.t;
    fs.stats.opportunities += 1; fs.stats.calls = fs.stats.opportunities;
    fs.inTick = true;
    try { return await originalTick(...args); }
    finally { fs.inTick = false; }
  };
  // 决策链：tick 之外的追加 decideOn 不再获得第二次机会。
  if (typeof agent.decideOn === 'function') {
    const originalDecide = agent.decideOn.bind(agent);
    agent.decideOn = async (...args) => {
      if (fs.t === world.t && !fs.inTick) { fs.stats.blockedChains += 1; return null; }
      return originalDecide(...args);
    };
  }
}

export function installFairSched(world, env = process.env) {
  if (!fairEnabled(env) || world?.independentWorld !== true || world?.gameRules !== true) return null;
  const fs = createFairState(world, { cap: fairCap(env) });
  for (const a of Object.values(world.agents)) if (!a.isPlayer) installFairGuard(world, a, fs);
  return fs;
}




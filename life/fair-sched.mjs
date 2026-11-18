// V7.3.2 episode 语义调度：
// 一次 agent.tick()（含反射/习惯/审议）= 一次 episode；tick 后的追加 decideOn（链）属于同一 episode，不再计机会。
// 每刻预算 = min(cap, eligible)，cap 默认 8：先保证每个可行动居民一次；同一居民可继续申请 episode，
// 直到本刻 episode 额度用尽（不设“每人每刻≤1”）。仅当 eligible > budget 时按 debt + lastOpportunityTick 轮转。
// 默认关（FAIR_SCHED=1），研究态永不安装；生理代谢/世界规则不变。
export const FAIR_ENV = 'FAIR_SCHED';
export const FAIR_CAP_ENV = 'FAIR_DECISION_CAP';
export const DEFAULT_FAIR_CAP = 8;

export function fairEnabled(env = process.env) { return env?.[FAIR_ENV] === '1'; }
export function fairCap(env = process.env) {
  const n = Number(env?.[FAIR_CAP_ENV] ?? DEFAULT_FAIR_CAP);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_FAIR_CAP;
}
export function fairBudget(population, cap = DEFAULT_FAIR_CAP) {
  return Math.max(1, Math.min(cap, Math.max(0, Math.floor(population))));
}

export function createFairState(world, { cap = fairCap() } = {}) {
  world.fairSched = {
    t: null, cap, allowed: new Set(), last: {}, debt: {}, denied: {}, episodes: {}, usedEpisodes: 0,
    inTick: false,
    stats: { ticks: 0, allowed: 0, peakAllowed: 0, opportunities: 0, blockedTicks: 0,
      blockedChains: 0, calls: 0, peakCalls: 0, budget: 0, eligible: 0, debtMax: 0, extraEpisodes: 0 },
  };
  return world.fairSched;
}

function eligibleIds(world, fs) {
  const ids = [];
  fs.denied = {};
  for (const a of Object.values(world.agents)) {
    if (a.isPlayer || a.dead) continue;
    const c = world.survival?.actClock?.[a.id];
    if (c?.busy) { fs.denied[a.id] = 'busy'; continue; }
    if (c && 60 - (c.tick?.usedMin ?? 0) <= 0) { fs.denied[a.id] = 'time'; continue; }
    if ((a.drives?.v?.energy ?? 1) <= 0.01) { fs.denied[a.id] = 'energy'; continue; }
    ids.push(a.id);
  }
  return ids;
}

function prepare(world, fs) {
  ensureFairAgents(world, fs); // 出生/新加入的居民自动进入调度，WeakSet 防重复包装
  const eligible = eligibleIds(world, fs);
  fs.stats.ticks += 1;
  fs.stats.eligible = eligible.length;
  fs.usedEpisodes = 0;
  fs.episodes = {};
  fs.allowed = new Set();
  if (!eligible.length) return;
  const budget = fs.cap; // cap 是每刻 episode 额度；先保证每个 eligible 一次，剩余额度供同人继续
  fs.episodeBudget = budget;
  fs.stats.budget = budget;
  if (eligible.length <= budget) {
    // 预算够：所有 eligible 都有机会；多出的 episode 额度留给同一居民继续（按调用顺序，受额度约束）。
    fs.allowed = new Set(eligible);
    fs.stats.allowed += eligible.length;
    fs.stats.peakAllowed = Math.max(fs.stats.peakAllowed, eligible.length);
    return;
  }
  const ranked = [...eligible].sort((a, b) => {
    const d = (fs.debt[b] ?? 0) - (fs.debt[a] ?? 0);
    if (d) return d;
    const l = (fs.last[a] ?? -1) - (fs.last[b] ?? -1);
    return l || a.localeCompare(b);
  });
  fs.allowed = new Set(ranked.slice(0, budget));
  for (const id of eligible) {
    if (fs.allowed.has(id)) fs.debt[id] = 0;
    else { fs.debt[id] = (fs.debt[id] ?? 0) + 1; fs.denied[id] = 'budget'; }
  }
  fs.stats.allowed += fs.allowed.size;
  fs.stats.peakAllowed = Math.max(fs.stats.peakAllowed, fs.allowed.size);
}

const WRAPPED = new WeakSet();
export function installFairGuard(world, agent, fs = world.fairSched) {
  if (!fs || typeof agent?.tick !== 'function' || WRAPPED.has(agent)) return;
  WRAPPED.add(agent);
  const originalTick = agent.tick.bind(agent);
  agent.tick = async (...args) => {
    if (fs.t !== world.t) { fs.t = world.t; prepare(world, fs); }
    const budget = fs.episodeBudget ?? 0;
    const baseOnly = async () => {
      // P0：被挡下的居民也必须结算本刻基础代谢/需求/内部演化；tick 内的 fairSuppress 分支只跑基础。
      agent.fairSuppress = true;
      try { return await originalTick(...args); }
      finally { agent.fairSuppress = false; }
    };
    if (fs.usedEpisodes >= budget) { fs.stats.blockedTicks += 1; await baseOnly(); return null; }
    if (!fs.allowed.has(agent.id)) { fs.stats.blockedTicks += 1; if (fs.denied[agent.id] !== 'budget') fs.denied[agent.id] = fs.denied[agent.id] ?? 'budget'; await baseOnly(); return null; }
    agent.fairSuppress = false;
    const used = fs.episodes[agent.id] ?? 0;
    // 防同一居民刷满整刻：所有入选者都拿到第一次 episode 之前，不允许第二次。
    if (used > 0 && [...fs.allowed].some((id) => (fs.episodes[id] ?? 0) === 0)) { fs.stats.blockedTicks += 1; return null; }
    if (used > 0) fs.stats.extraEpisodes += 1;
    fs.episodes[agent.id] = used + 1;
    fs.usedEpisodes += 1;
    if (used === 0) { fs.debt[agent.id] = 0; }
    fs.last[agent.id] = world.t;
    fs.stats.opportunities += 1;
    fs.stats.calls = fs.stats.opportunities;
    fs.inTick = true;
    try { return await originalTick(...args); }
    finally { fs.inTick = false; }
  };
  // 链决策（tick 后 decideOn）属于同一 episode：不拦、不计机会。
}

export function ensureFairAgents(world, fs = world.fairSched) {
  if (!fs) return;
  for (const a of Object.values(world.agents)) if (!a.isPlayer && !a.dead) installFairGuard(world, a, fs);
}

export function installFairSched(world, env = process.env) {
  if (!fairEnabled(env) || world?.independentWorld !== true || world?.gameRules !== true) return null;
  const fs = createFairState(world, { cap: fairCap(env) });
  ensureFairAgents(world, fs);
  return fs;
}



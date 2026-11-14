// AI 合作层（Phase C）。服务端权威的合作调度：意愿评估 → 协助/拒绝/替代；
// 自发识别公共需求 → 合作任务分解 → 多步骤执行与失败重规划。
// 只作用于 world.survival.coop.enabled（默认关）；lab/town 无 survival ⇒ 逐位不变，
// Phase A/B（coop 关）轨迹亦不变。配对闸门用同 seed「独建 vs 协作」比完工时间。
// 确定性：不消费 Math.random；意愿/选址均由世界事实推导。
import { BUILDINGS, GATHER_BY_LOC, coopPoolGather, doPlan, doBuild } from './production.mjs';
import { isAlive, livingResidents } from './viability.mjs';
import { laborStage } from './households.mjs';
// 位置只能经 body.move 改：它同时维护 world.occupancy。直接写 world.loc[id] 会让
// occupancy 里留着旧地点、新地点没有该角色，下一次 move() 读 occupancy[from] 时崩，
// 然后 survplay 的 try/catch 每拍吞一条 agentError，工人整条决策环停摆（2026-11-12 实测）。
import { move as moveTo, BASE_KINDS, SURV_COST } from './body.mjs';

export const COOP = Object.freeze({
  assistThreshold: 0.5,
  alternativeThreshold: 0.3,
  maxWorkers: 3,
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function initCoop(s, enabled = false) {
  s.coop = { enabled: !!enabled, task: null, completions: [], refusals: 0, replans: 0 };
}

// 意愿评估：需求(自身匮乏) / 关系(信任) / 风险(天气) / 回报(公共需求严重度)。
export function willingness(world, agentId, task = {}) {
  const a = world.agents[agentId];
  if (!a || a.isPlayer) return { score: 0, decision: 'refuse', reason: 'NOT_ELIGIBLE' };
  const ownScarcity = 1 - (a.viab?.v ?? 1);                       // 自己越匮乏越难帮人
  const trust = (a.relations?.get?.(task.requester ?? 'p1')?.trust ?? 30) / 100; // P0-4：读该角色对请求者的真实信任（关系在 agent.relations，不在世界级）
  const risk = (world.weather === 'rain' || world.weather === 'cold') ? (task.repair ? (world.survival?.repairRisk ?? 0.3) : 0.3) : 0; // E2 L3：维修雨天风险可单独降
  const reward = clamp01(task.severity ?? 0.5);
  const score = clamp01(0.35 * trust + 0.35 * reward + 0.15 * (1 - ownScarcity) - risk + 0.15);
  const decision = score >= COOP.assistThreshold ? 'assist' : score >= COOP.alternativeThreshold ? 'alternative' : 'refuse';
  return { score: Number(score.toFixed(3)), decision, reason: decision === 'assist' ? 'WILLING' : decision === 'alternative' ? 'PARTIAL' : 'UNWILLING' };
}

// 自发识别公共需求：缺粮→储粮、无住所→住所、无生产→工坊、损坏→维修优先。
export function identifyPublicNeeds(world) {
  const s = world.survival; if (!s) return [];
  const pop = livingResidents(world).length; // P0-1：公共需求按存活人口算
  const has = (t) => (s.buildings ?? []).some((b) => b.type === t && b.integrity > 0);
  const under = (t) => (s.sites ?? []).some((x) => x.type === t);   // 在建中不再重复派同类活
  const needs = [];
  const damaged = (s.buildings ?? []).find((b) => (s.repairEarly ? b.integrity < 1 : b.integrity <= 0)); // E2 L1：维修触发阈值
  if (damaged) needs.push({ type: damaged.type, severity: 0.9, repair: true, loc: damaged.loc });
  if (s.store < pop * 2 && !has('granary') && !under('granary')) needs.push({ type: 'granary', severity: 0.8 });
  if (!has('shelter') && !under('shelter')) needs.push({ type: 'shelter', severity: 0.6 });
  if (!has('workshop') && !under('workshop')) needs.push({ type: 'workshop', severity: 0.4 });
  return needs.sort((a, b) => b.severity - a.severity);
}

// 任务分解：采集材料 → 奠基 → 施工（维修另走 repair）。
export const decompose = (task) => (task.repair ? ['repair'] : ['gather', 'plan', 'build']);

const pickBuildLoc = (world, exclude) => {
  const s = world.survival;
  const taken = (l) => (s.sites ?? []).some((x) => x.loc === l) || (s.buildings ?? []).some((x) => x.loc === l);
  return (world.outdoor ?? []).find((l) => l !== exclude && !taken(l)) ?? null;
};

export const assignWorkers = (world, task) => Object.keys(world.agents)
  .filter(id => !world.unifiedCooperation || !world.agents[id].isPlayer && availableForCooperation(world, id, task))
  .filter((id) => !world.agents[id].isPlayer && isAlive(world.agents[id]) && laborStage(world, id)) // P0-1 死者不组队；P1-1 儿童不劳动
  .map((id) => ({ id, w: willingness(world, id, task) }))
  .filter((x) => x.w.decision !== 'refuse')
  .sort((a, b) => b.w.score - a.w.score)
  .slice(0, COOP.maxWorkers)
  .map((x) => x.id);

// 单拍执行：每个工人做一个动作；失败重规划（换选址 / 记拒绝）。
function execTick(world, t) {
  const s = world.survival; const def = BUILDINGS[t.type];
  const relocate = (id, loc) => {
    const changed = world.loc[id] !== loc;
    moveTo(world, id, loc);
    if (changed) world.onLegacyLabor?.(id, 'move_to');
  };
  for (const id of t.workers) {
    if (t.phase === 'gather') {
      const cost = (s.repairEarly && t.repair) ? { wood: 1, stone: 1 } : def.cost; // E3：维修采料 1/1，不按建筑成本
      if (s.inv.wood >= cost.wood && s.inv.stone >= cost.stone) t.phase = (s.repairEarly && t.repair) ? 'repair' : 'plan';
      else {
        const res = s.inv.wood < cost.wood ? 'wood' : 'stone';
        const stock = s.resStock ?? {};
        const loc = Object.keys(GATHER_BY_LOC).find((l) => GATHER_BY_LOC[l] === res && (stock[l] ?? 0) > 0); // P0-3：去有储量的地点
        if (loc) {
          relocate(id, loc);
          if (coopPoolGather(world, id).ok) world.onLegacyLabor?.(id, 'gather');
        }
        // 无储量：本拍等待再生，不空转采集
      }
    }
    if (t.phase === 'plan') {
      relocate(id, t.loc);
      const r = doPlan(world, id, t.type);
      if (r.ok) { world.onLegacyLabor?.(id, 'plan'); t.phase = 'build'; }
      else if (r.code === 'OCCUPIED' || r.code === 'NOT_OUTDOOR') {
        const nl = pickBuildLoc(world, t.loc);
        if (nl && nl !== t.loc) { t.loc = nl; s.coop.replans += 1; t.tries = (t.tries ?? 0) + 1; if (t.tries > 3) t.abandoned = true; }
        else t.abandoned = true;   // 没有空位：放弃该任务，绝不空转重规划
      } else if (r.code === 'NO_MATERIAL') t.phase = 'gather';
    }
    if (t.phase === 'build') {
      relocate(id, t.loc);
      const r = doBuild(world, id);
      if (r.ok) world.onLegacyLabor?.(id, 'build');
      if (r.completed) { s.coop.completions.push({ type: t.type, tick: world.t, workers: t.workers.length }); return { completed: t.type }; }
      if (!r.ok && r.code === 'NO_SITE') {
        // P0-5：工地消失——玩家已建成则记完工，否则正常结束任务（不空转）。
        if ((s.buildings ?? []).some((b) => b.loc === t.loc && b.type === t.type)) { s.coop.completions.push({ type: t.type, tick: world.t, workers: t.workers.length }); return { completed: t.type }; }
        t.abandoned = true;
      }
    }
    if (t.phase === 'repair') {
      relocate(id, t.loc);
      // E3：执行侧阈值与需求侧成对（repairEarly）；旧档/关开关保持 <=0 逐位不变
      const b = (s.buildings ?? []).find((x) => x.loc === t.loc && (s.repairEarly ? x.integrity < 1 : x.integrity <= 0));
      if (b && s.inv.wood >= 1 && s.inv.stone >= 1) { s.inv.wood -= 1; s.inv.stone -= 1; b.integrity = 1; world.onLegacyLabor?.(id, 'repair'); s.coop.completions.push({ type: t.type, tick: world.t, repair: true }); return { completed: t.type }; }
      if (s.repairEarly && !b) t.abandoned = true;   // E3：无目标＝放弃，禁止 fallthrough 重建
      else t.phase = 'gather';
    }
  }
  return { phase: t.phase };
}

// 每拍调用（仅 coop 开启）：无任务则采纳既有工地或识别公共需求并组队；有任务则推进。
function syncTask(world, task) {
  const s = world.survival;
  const building = s.buildings.find(b => b.loc === task.loc);
  if (task.repair ? building?.type === task.type && building.integrity >= 1 : building?.type === task.type) {
    s.coop.completions.push({ type: task.type, tick: world.t, workers: task.workers.length, ...(s.settlementLife ? {
      loc:task.loc, participants:task.repair?task.repairedBy??[]:Object.keys(building.contributors??{}),
    } : {}), ...(task.repair ? { repair: true } : {}) });
    return { completed: task.type };
  }
  const site = s.sites.find(b => b.loc === task.loc);
  if (task.repair ? building?.type !== task.type : (building || site && site.type !== task.type)) {
    const next = task.repair || task.adopted || task.requester ? null : pickBuildLoc(world, task.loc);
    if (!next) task.abandoned = true;
    else { task.loc = next; s.coop.replans += 1; }
  }
  if (!task.repair) {
    if (task.phase === 'build' && !site && (task.adopted || task.requester)) task.abandoned = true;
    task.phase = site?.type === task.type ? 'build' : 'gather';
  }
  return { phase: task.phase };
}

export function finishCooperation(world) {
  const c = world.survival.coop;
  if (!c.task) return;
  const result = syncTask(world, c.task);
  if (c.task.abandoned) c.refusals += 1;
  if (result.completed || c.task.abandoned) c.task = null;
}

export function cooperationCandidate(world, id) {
  const s = world.survival;
  const task = s?.coop?.task;
  if (!world.unifiedCooperation || !s?.coop?.enabled || !task?.workers.includes(id) || task.abandoned) return null;
  if (!availableForCooperation(world, id, task)) return null;
  const agent = world.agents[id];
  const here = world.loc[id];
  const bag = world.pinv?.[id] ?? {};
  const site = s.sites.find(b => b.loc === task.loc && b.type === task.type);
  const building = s.buildings.find(b => b.loc === task.loc);
  if (task.repair ? !building || building.integrity >= 1 : building || (!site && (task.adopted || task.requester))) return null;
  const move = to => ({ kind: 'move_to', to, id: `move_to:${to}`, label: `去${world.locs[to] ?? to}` });
  let act;
  const cost = task.repair ? { wood: 1, stone: 1 } : BUILDINGS[task.type].cost;
  const materials = Object.keys(cost);
  const missing = materials.find(res => (bag[res] ?? 0) + s.inv[res] < cost[res]);
  if (site || !missing) {
    act = here !== task.loc ? move(task.loc)
      : task.repair ? { kind: 'repair', id: `repair:${task.type}` }
      : site ? { kind: 'build', id: 'build' } : { kind: 'plan', type: task.type, id: `plan:${task.type}` };
  } else {
    const share = materials.find(res => bag[res] > 0 && s.inv[res] < cost[res] &&
      task.workers.some(other => other !== id && (world.pinv[other]?.[missing] ?? 0) + s.inv[missing] >= cost[missing]));
    if (share) {
      act = here === 'store' ? { kind: 'deposit', type: share, id: `deposit:${share}` } : move('store');
    } else {
      const source = Object.keys(GATHER_BY_LOC).find(loc => GATHER_BY_LOC[loc] === missing && s.resStock[loc] > 0);
      if (!source) return null;
      act = here === source ? { kind: 'gather', id: 'gather' } : move(source);
    }
  }
  const base = BASE_KINDS[act.kind];
  const willingnessNow = willingness(world, id, task);
  const value = willingnessNow.score * (agent.drives.v.energy - 0.22) / 0.78;
  return { ...act, label: `合作·${act.label ?? base.label}（${BUILDINGS[task.type].label}）`,
    cost: SURV_COST[act.kind], impulse: base.impulse, serves: { social: .15, stimulation: .3 },
    cooperationValue: value, cooperation: true };
}

function availableForCooperation(world, id, task) {
  const a = world.agents[id];
  return isAlive(a) && laborStage(world, id) && (a.drives?.v?.energy ?? 0) > .22 &&
    (a.viab?.v ?? 0) > .18 && willingness(world, id, task).decision !== 'refuse';
}

export function stepCooperation(world) {
  const s = world.survival; if (!s?.coop?.enabled) return null;
  const c = s.coop;
  c.exits ??= 0;
  // P1-D：聚落灭绝后不再派活/记拒绝；自然生态继续，但没有人可被组织。
  // 只有真正灭绝（居民都被标记 dead）才停止派活；研究占位 agent 没有 dead 字段，保持原行为。
  if (!Object.values(world.agents).some((a) => !a.isPlayer && !a.dead)) { if (c.task) c.task = null; return null; }
  if (!c.task) {
    // P0-5：优先采纳既有工地（玩家奠基也算，已奠基⇒直接施工），再考虑自发公共需求。
    const site = (s.sites ?? [])[0];
    const need = site ? { type: site.type, severity: 0.7, loc: site.loc, adopted: true } : identifyPublicNeeds(world)[0];
    if (!need) return null;
    const loc = need.loc ?? pickBuildLoc(world);
    if (!loc) return null;   // 没有可用选址就不再派活，避免空转
    const workers = assignWorkers(world, need);
    if (!workers.length) { c.refusals += 1; return { refused: true }; }
    c.task = { ...need, loc, phase: site ? 'build' : decompose(need)[0], workers, startedAt: world.t };
  }
  // P0-5 中途退出：死亡立即退出；替代/自发工人每拍重评意愿，拒绝即退出（明确协助承诺者保持稳定）。
  const task = c.task;
  task.workers = task.workers.filter((id) => {
    const a = world.agents[id];
    if (world.unifiedCooperation && !availableForCooperation(world, id, task)) { c.exits += 1; return false; }
    if (!isAlive(a)) { c.exits += 1; return false; }
    if (task.commit?.[id] === 'alternative' || task.adopted) {
      if (willingness(world, id, task).decision === 'refuse') { c.exits += 1; return false; }
    }
    return true;
  });
  if (!task.workers.length) {
    const again = assignWorkers(world, task);
    if (!again.length) { c.refusals += 1; c.task = null; return { refused: true }; }
    task.workers = again;
  }
  if (world.unifiedCooperation) { finishCooperation(world); return c.task; }
  const r = execTick(world, task);
  if (r.completed || task.abandoned) { if (task.abandoned) c.refusals += 1; c.task = null; }
  return r;
}

// 配对闸门载体：同 seed 下「独建(1 人) vs 协作(意愿组队)」建同一建筑的完工拍数。
export function runConstruction({ seed = 7, type = 'granary', coop = true, maxTicks = 400, makeWorld, spawn } = {}) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0 });
  for (const [id, name] of [['a1', '岑'], ['a2', '绛'], ['a3', '蓑']]) { world.agents[id] = { id, name }; spawn(world, id, 'home'); }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(world, 'p1', 'hall');
  initCoop(world.survival, true);
  const workers = coop ? assignWorkers(world, { type, severity: 0.8 }) : ['a1'];
  const task = { type, severity: 0.8, loc: pickBuildLoc(world), phase: 'gather', workers, startedAt: 0 };
  world.survival.coop.task = task;
  for (let t = 1; t <= maxTicks; t++) {
    world.t = t;
    const r = execTick(world, task);
    if (r.completed) return { ticks: t, completed: true, workers: workers.length };
  }
  return { ticks: maxTicks, completed: false, workers: workers.length };
}

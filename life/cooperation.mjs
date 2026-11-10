// AI 合作层（Phase C）。服务端权威的合作调度：意愿评估 → 协助/拒绝/替代；
// 自发识别公共需求 → 合作任务分解 → 多步骤执行与失败重规划。
// 只作用于 world.survival.coop.enabled（默认关）；lab/town 无 survival ⇒ 逐位不变，
// Phase A/B（coop 关）轨迹亦不变。配对闸门用同 seed「独建 vs 协作」比完工时间。
// 确定性：不消费 Math.random；意愿/选址均由世界事实推导。
import { BUILDINGS, GATHER_BY_LOC, doGather, doPlan, doBuild, effectiveMods } from './production.mjs';

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
  const trust = (world.relations?.get?.(agentId, task.requester ?? 'p1')?.trust ?? 30) / 100;
  const risk = (world.weather === 'rain' || world.weather === 'cold') ? 0.3 : 0;
  const reward = clamp01(task.severity ?? 0.5);
  const score = clamp01(0.35 * trust + 0.35 * reward + 0.15 * (1 - ownScarcity) - risk + 0.15);
  const decision = score >= COOP.assistThreshold ? 'assist' : score >= COOP.alternativeThreshold ? 'alternative' : 'refuse';
  return { score: Number(score.toFixed(3)), decision, reason: decision === 'assist' ? 'WILLING' : decision === 'alternative' ? 'PARTIAL' : 'UNWILLING' };
}

// 自发识别公共需求：缺粮→储粮、无住所→住所、无生产→工坊、损坏→维修优先。
export function identifyPublicNeeds(world) {
  const s = world.survival; if (!s) return [];
  const mods = effectiveMods(world);
  const pop = Object.values(world.agents).filter((a) => !a.isPlayer).length;
  const has = (t) => (s.buildings ?? []).some((b) => b.type === t && b.integrity > 0);
  const needs = [];
  const damaged = (s.buildings ?? []).find((b) => b.integrity <= 0);
  if (damaged) needs.push({ type: damaged.type, severity: 0.9, repair: true });
  if (s.store < pop * 2 && !has('granary')) needs.push({ type: 'granary', severity: 0.8 });
  if (!has('shelter')) needs.push({ type: 'shelter', severity: 0.6 });
  if (!has('workshop')) needs.push({ type: 'workshop', severity: 0.4 });
  return needs.sort((a, b) => b.severity - a.severity);
}

// 任务分解：采集材料 → 奠基 → 施工（维修另走 repair）。
export const decompose = (task) => (task.repair ? ['repair'] : ['gather', 'plan', 'build']);

const pickBuildLoc = (world, exclude) => {
  const s = world.survival;
  const taken = (l) => (s.sites ?? []).some((x) => x.loc === l) || (s.buildings ?? []).some((x) => x.loc === l);
  return (world.outdoor ?? []).find((l) => l !== exclude && !taken(l)) ?? 'yard';
};

const assignWorkers = (world, task) => Object.keys(world.agents)
  .filter((id) => !world.agents[id].isPlayer)
  .map((id) => ({ id, w: willingness(world, id, task) }))
  .filter((x) => x.w.decision !== 'refuse')
  .sort((a, b) => b.w.score - a.w.score)
  .slice(0, COOP.maxWorkers)
  .map((x) => x.id);

// 单拍执行：每个工人做一个动作；失败重规划（换选址 / 记拒绝）。
function execTick(world, t) {
  const s = world.survival; const def = BUILDINGS[t.type];
  for (const id of t.workers) {
    if (t.phase === 'gather') {
      if (s.inv.wood >= def.cost.wood && s.inv.stone >= def.cost.stone) t.phase = 'plan';
      else {
        const res = s.inv.wood < def.cost.wood ? 'wood' : 'stone';
        world.loc[id] = Object.keys(GATHER_BY_LOC).find((l) => GATHER_BY_LOC[l] === res) ?? 'yard';
        doGather(world, id);
      }
    }
    if (t.phase === 'plan') {
      world.loc[id] = t.loc;
      const r = doPlan(world, id, t.type);
      if (r.ok) t.phase = 'build';
      else if (r.code === 'OCCUPIED' || r.code === 'NOT_OUTDOOR') { t.loc = pickBuildLoc(world, t.loc); s.coop.replans += 1; }
      else if (r.code === 'NO_MATERIAL') t.phase = 'gather';
    }
    if (t.phase === 'build') {
      world.loc[id] = t.loc;
      const r = doBuild(world, id);
      if (r.completed) { s.coop.completions.push({ type: t.type, tick: world.t, workers: t.workers.length }); return { completed: t.type }; }
    }
    if (t.phase === 'repair') {
      world.loc[id] = t.loc;
      // 维修走 production.doRepair 需材料；此处简化为直接恢复（服务端权威）
      const b = (s.buildings ?? []).find((x) => x.loc === t.loc && x.integrity <= 0);
      if (b && s.inv.wood >= 1 && s.inv.stone >= 1) { s.inv.wood -= 1; s.inv.stone -= 1; b.integrity = 1; s.coop.completions.push({ type: t.type, tick: world.t, repair: true }); return { completed: t.type }; }
      t.phase = 'gather';
    }
  }
  return { phase: t.phase };
}

// 每拍调用（仅 coop 开启）：无任务则识别公共需求并组队；有任务则推进。
export function stepCooperation(world) {
  const s = world.survival; if (!s?.coop?.enabled) return null;
  const c = s.coop;
  if (!c.task) {
    const need = identifyPublicNeeds(world)[0];
    if (!need) return null;
    const workers = assignWorkers(world, need);
    if (!workers.length) { c.refusals += 1; return { refused: true }; }
    c.task = { ...need, loc: pickBuildLoc(world), phase: decompose(need)[0], workers, startedAt: world.t };
  }
  const r = execTick(world, c.task);
  if (r.completed) c.task = null;
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

import { farmGroundReady, nextFarmBed } from './farmland.mjs';
import { SURV } from './worldstate.mjs';
import { laborStage, strictLifecycle } from './households.mjs';
// P1（派单§七）多步骤行动组合：把"目标"分解为有序"需求"，每个需求映射到当前应执行的基础动作
// （含前置移动/采集）。planGoal 每次调用重评⇒资源/环境变化或失败后自动重规划。
// 复用既有 affordances/validate/actuate，不另造决策器；基础动作仍由规则层裁决、世界计算结果。
// 示范目标用于验证组合能力（派单允许少量示范）；自主层默认决策环不受影响。
import { BUILDINGS, gatherPlace, forageRule } from './production.mjs';
import { validate, actionId } from './rules.mjs';
import { actuate, BASE_KINDS, SURV_COST, livingResidents } from './body.mjs';

const completed = (w, type) => w.survival.buildings.some(b => b.type === type && b.integrity > 0);
const founded = (w, type) => completed(w,type) || w.survival.sites.some(s => s.type === type);
const pool = (w, id) => {
  const bag = w.pinv?.[id] ?? { wood: 0, stone: 0 };
  return { wood: bag.wood + (w.survival?.inv.wood ?? 0), stone: bag.stone + (w.survival?.inv.stone ?? 0) };
};
const freeOutdoor = (w, exclude) => (w.outdoor ?? []).find((l) => l !== exclude
  && !(w.survival.sites ?? []).some((s) => s.loc === l) && !(w.survival.buildings ?? []).some((b) => b.loc === l));

// 采集前置：不在资源地点先移动，到了再采；无储量则等待再生（返回 null）。
function gatherAction(w, id, res) {
  const loc = gatherPlace(w,res,w.loc[id]);
  if (!loc) return null;
  return w.loc[id] === loc ? { kind: 'gather' } : { kind: 'move_to', to: loc };
}
function planAction(w, id, type) {
  const here = w.loc[id];
  const hereFree = (w.outdoor ?? []).includes(here)
    && !(w.survival.sites ?? []).some((s) => s.loc === here) && !(w.survival.buildings ?? []).some((b) => b.loc === here);
  if (hereFree) return { kind: 'plan', type };
  const loc = freeOutdoor(w, here);
  return loc ? { kind: 'move_to', to: loc } : null;
}
function buildAction(w, id, type) {
  const site = (w.survival.sites ?? []).find((s) => s.type === type);
  if (!site) return null;
  return w.loc[id] === site.loc ? { kind: 'build' } : { kind: 'move_to', to: site.loc };
}
function forageAction(w, id) {
  const available = loc => !w.survival.wildBerries || (w.survival.wildBerries[loc] ?? 0) >= 1;
  const here = w.loc[id];
  if ((w.outdoor ?? []).includes(here) && available(here))
    return forageRule(w,id).ok ? { kind: 'forage' } : null;
  const loc = (w.outdoor ?? []).find(available);
  return loc ? { kind: 'move_to', to: loc } : null;
}
function exchangeAction(w, id) {
  if (w.loc[id] === 'store') return { kind: 'exchange', type: 'berry' };
  return { kind: 'move_to', to: 'store' };
}

export const GOALS = Object.freeze({
  shelter: {
    label: '建造住所',
    steps: [
      { need: (w, id) => founded(w, 'shelter') || pool(w, id).wood >= BUILDINGS.shelter.cost.wood, action: (w, id) => gatherAction(w, id, 'wood') },
      { need: (w, id) => founded(w, 'shelter') || pool(w, id).stone >= BUILDINGS.shelter.cost.stone, action: (w, id) => gatherAction(w, id, 'stone') },
      { need: (w, id) => founded(w, 'shelter'), action: (w, id) => planAction(w, id, 'shelter') },
      { need: (w, id) => completed(w, 'shelter'), action: (w, id) => buildAction(w, id, 'shelter') },
    ],
  },
  farmland: {
    label: '补足农田',
    steps: [
      { need: w => !w.survival.plots.some(p => p.growth === 0), action: w =>
        ({ kind: 'plant', plot: w.survival.plots.find(p => p.growth === 0).id }) },
      { need: (w, id) => pool(w, id).wood >= 1, action: (w, id) => gatherAction(w, id, 'wood') },
      { need: (w, id) => w.loc[id] === 'garden', action: () => ({ kind: 'move_to', to: 'garden' }) },
      { need: w => !farmGroundReady(w) || !nextFarmBed(w),
        action: w => ({ kind: 'till', plot: nextFarmBed(w).id }) },
    ],
  },
  food: {
    label: '储备食物',
    steps: [
      { need: (w, id) => (w.survival.produce?.berry ?? 0) >= 1 || w.survival.store >= 6, action: (w, id) => forageAction(w, id) },
      { need: (w, id) => w.survival.store >= 6, action: (w, id) => exchangeAction(w, id) },
    ],
  },
});

// 返回当前应执行的基础动作（第一个未满足需求）；目标完成或暂无可行动作返回 null。每次重评⇒自动重规划。
export function planGoal(w, id, goalId) {
  const goal = GOALS[goalId];
  if (!goal || !w.survival || goalId === 'farmland' && !w.survival.farmLife) return null;
  if (goalId === 'farmland' && !w.survival.plots.some(p => p.growth === 0) &&
      (!farmGroundReady(w) || !nextFarmBed(w))) return null;
  for (const step of goal.steps) {
    if (!step.need(w, id)) {
      const act = step.action(w, id);
      if (act?.kind === 'plant' && w.loc[id] !== 'garden') return { kind: 'move_to', to: 'garden', goal: goalId };
      if (act?.kind === 'plant' && w.survival.water < (w.survival.plantWater ?? .1)) return null;
      return act ? { ...act, goal: goalId } : null;
    }
  }
  return null;
}

export function goalCandidates(w, id) {
  if (!w.autonomousGoals || !w.survival || w.agents[id]?.isPlayer) return [];
  if (strictLifecycle(w) && !laborStage(w,id)) return [];
  const a = w.agents[id], s = w.survival;
  const energy = a.drives.v.energy;
  const foodPressure = Math.max(0, 1 - s.store / Math.max(3, livingResidents(w).length * 2));
  const priorities = { shelter: energy > .28 ? .62 * energy * a.viab.v : 0, food: .72 * foodPressure };
  if (s.farmLife && foodPressure > .25 && energy > .42 && a.viab.v > .45) {
    const workers = livingResidents(w).filter(resident =>
      laborStage(w, resident.id) && resident.drives.v.energy > .42).length;
    const demand = s.history.at(-1)?.need ?? livingResidents(w).length + Number(Boolean(s.playerEats));
    const output = s.plots.length * SURV.yieldPerPlot * SURV.growPerDay *
      (.4 + .6 * s.water) * (.4 + .6 * s.soil);
    const shortage = Math.max(0, 1 - output / Math.max(1, demand));
    const empty = s.plots.some(p => p.growth === 0);
    if ((empty || workers >= 2 && farmGroundReady(w) && nextFarmBed(w)) && shortage > .1) {
      priorities.farmland = .66 * energy * (foodPressure + shortage);
    }
  }
  return Object.entries(priorities).flatMap(([goal, value]) => {
    const action = value > 0 && planGoal(w,id,goal);
    if (!action || !validate(w,id,action).ok) return [];
    const base = BASE_KINDS[action.kind];
    const key = action.kind === 'plant' ? 'plant' : action.type ? `${action.kind}:${action.type}` : actionId(action);
    return [{ ...action, id: key, label: `${GOALS[goal].label}·${base.label}`,
      cost: SURV_COST[action.kind], impulse: base.impulse, serves: { energy: goal==='food' ? .2 : 0 },
      goalValue: value }];
  });
}

export function goalProgress(w, id, goalId) {
  const goal = GOALS[goalId];
  if (!goal) return 0;
  return goal.steps.filter((s) => s.need(w, id)).length / goal.steps.length;
}

// 经规则层裁决＋世界执行一步（与自主层同一入口）；非法/无步返回失败，不消耗资源。
export function executeGoalStep(w, id, goalId) {
  const intent = planGoal(w, id, goalId);
  if (!intent) return { ok: false, code: 'NO_STEP' };
  const gate = validate(w, id, intent);
  if (!gate.ok) return gate;
  return actuate(w, id, intent);
}
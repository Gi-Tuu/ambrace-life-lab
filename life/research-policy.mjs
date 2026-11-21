// 研究态/旧档（!world.simClock）的**唯一**显式策略模块。
//
// 这里不是第二套时钟或空间实现：它是“旧行为作为配置”的声明处，正式路径与新时钟/space
// 仍只有一套共享实现。能由共享实现表达的都已上移：
//   · 60 分/刻、1440 分/日：直接取 sim-clock 的游戏分钟常量，不再另写 60/1440；
//   · 居民 12/刻、玩家 10/刻、村内同步 40/刻：space.mjs 的 legacy speed-budget 行，
//     刻数仍走同一个 travelTicks 公式，没有第二套出行代码；
//   · 旧 60 分/100 点池的拒绝码与文案留在这里（ARCH-2D-01 的唯一白名单）。
//
// 仍保留为**研究策略**（新时钟表达不了、也不该改写的语义）：
//   · 每 tick = world.t + 1 = 60 游戏分钟，整刻一次 worldTick + per-tick think；
//   · 居民 60 分池/4 动作 cap/2 次链式决策、玩家每刻 100 点池、旧超时码；
//   · 居民 12/刻、玩家 10/刻的直线旅行（无 space 路径/几何校验）；
//   · 研究态身体每 tick 结算一次（不创建 simClock/minuteMetab）。
// 这些分支由调用方按 !world.simClock / !actTimeModel 显式选择，不得复制成第二个模块。
import { GAME_MINUTES_PER_HOUR, GAME_MINUTES_PER_DAY } from './sim-clock.mjs';
import { travelTicksAt } from './space.mjs';

export const RESEARCH_ONLY = true;
export const LEGACY_TIME_CODE = 'TIME_WAIT';
export const RESEARCH_TICK_MINUTES = GAME_MINUTES_PER_HOUR;
export const RESEARCH_DAY_MINUTES = GAME_MINUTES_PER_DAY;
export const RESEARCH_PLAYER_BUDGET = 100;
export const RESEARCH_RESIDENT_ACTION_CAP = 4;
export const RESEARCH_RESIDENT_CHAIN_MAX = 2;

// 研究态 12/10/40 单位/刻（居民直线旅行 / 玩家移动 / 村内位置同步）。
// 这里声明数值与旅行刻数；刻数仍由 space.mjs 的同一个 travelTicksAt 公式推导，
// 不存在第二套出行代码。space.mjs 是浏览器/服务端共享的纯几何模块，不再反向 import 本策略。
export const RESEARCH_SPEED_UNITS_PER_TICK = Object.freeze({
  resident: 12,
  player: 10,
  playerSyncInCamp: 40,
});
// 旧名兼容：历史调用方从 space.mjs 取这个名字；现在统一从 policy 取。
export const LEGACY_RESEARCH_UNITS_PER_TICK = RESEARCH_SPEED_UNITS_PER_TICK;
export const researchTravelTicks = (distance, min = 2) =>
  travelTicksAt(distance, RESEARCH_SPEED_UNITS_PER_TICK.resident, min);

// 研究态整刻语义的单一声明：一刻=60 分、整刻一次 worldTick + per-tick think、
// 身体每刻结算一次、居民 4 动作 cap / 2 次链式决策。正式连续路径不读这个对象。
export const RESEARCH_TICK_POLICY = Object.freeze({
  minutes: RESEARCH_TICK_MINUTES,
  perTickThink: true,
  bodyPerTick: true,
  residentActionCap: RESEARCH_RESIDENT_ACTION_CAP,
  residentChainMax: RESEARCH_RESIDENT_CHAIN_MAX,
  speedUnitsPerTick: RESEARCH_SPEED_UNITS_PER_TICK,
  legacyTimeCode: LEGACY_TIME_CODE,
});

// tickLegacy：per-tick think 的显式开关（不是散落在调用点的字面量 true）。
export function legacyPerTickThink() {
  return RESEARCH_TICK_POLICY.perTickThink;
}

// resident-time：legacy 日池装不下一个动作。
export function legacyResidentTimeRefusal() {
  return { ok: false, code: LEGACY_TIME_CODE };
}

// survplay-actions：legacy 本刻 60 分池用尽。
export function legacyPlayerTickRefusal() {
  return { code: LEGACY_TIME_CODE, why: '这一拍的时间用完了，等下一拍' };
}

// agent：把预算 code 变成玩家/日志能读的一句话（只服务 legacy code）。
export function legacyRefusalWhy(code) {
  if (code === LEGACY_TIME_CODE) return '这一天的时间用完了';
  if (code === 'BUSY') return '手上还有没做完的动作';
  return '这一刻的动作数到顶了';
}

// 旧路径玩家 100 点本刻预算（V72_TIME=0 / 研究态）。
export function legacyBudgetLeft(w) {
  const s = w.survival;
  if (s.p1BudgetTick !== w.t) { s.p1BudgetTick = w.t; s.p1BudgetLeft = RESEARCH_PLAYER_BUDGET; }
  return s.p1BudgetLeft;
}
export function legacySpendPlayerTime(w, cost) {
  if (!w.independentWorld) return true;
  const s = w.survival;
  legacyBudgetLeft(w);
  if (s.p1BudgetLeft + 1e-9 < cost) return false;
  s.p1BudgetLeft -= cost;
  return true;
}
export function legacyRefundPlayerTime(w, cost) {
  if (!w.independentWorld || !(cost > 0)) return;
  legacyBudgetLeft(w);
  w.survival.p1BudgetLeft += cost;
}
export function legacyPlayerTimeLeft(w) {
  const s = w.survival;
  return s.p1BudgetTick === w.t ? s.p1BudgetLeft : RESEARCH_PLAYER_BUDGET;
}


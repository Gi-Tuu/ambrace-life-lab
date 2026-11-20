// 研究态旧时间模型（唯一隔离点）。
//
// 正式游戏（world.simClock 存在）没有旧超时码、没有"每刻/每日 N 次"配额：
//   · 短动作按连续时钟立即结算；
//   · 长动作占用 [startMin,endMin)，到点由分钟调度结算；
//   · 决策机会由 ThinkScheduler 按游戏分钟发放。
//
// 这里只保留 **研究态/旧档/对照回放**（!world.simClock：gameRules:false、simTime:false、
// V72_TIME=0）仍在使用的 60 分钟刻 + 每日池行为，逐位不变。ARCH-2D-01 只在本文件放行
// 旧超时码；正式编排层（host/host-world/survplay）不得 import 本模块。
export const RESEARCH_ONLY = true;
export const LEGACY_TIME_CODE = 'TIME_WAIT';
export const RESEARCH_PLAYER_BUDGET = 100;
export const RESEARCH_TICK_MINUTES = 60;
export const RESEARCH_DAY_MINUTES = 1440;

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

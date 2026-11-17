import { recordSettlementEvent } from './settlement-events.mjs';
// V7.2 阶段 B 第 3 步：居民侧个人时间与进行中动作。
//
// 规则（与玩家侧同一口径）：
// - 每刻 60 游戏分钟、每天 1440 分钟；短动作可在同一刻内连续执行，但每刻有硬上限（防 CPU 爆炸）。
// - 同一角色同一时刻只有一个进行中的动作（busy）。动作装不下当前刻的剩余分钟时进入 busy，
//   下一（几）刻推进；施工每满 30 分钟立即落一单位劳动 ⇒ 被打断时已完成的进度保留。
// - 普通劳动扣体力（drives.energy），viab 只承担长期损耗；体力不够则拒绝/中止。
// - 研究态（非 independentWorld 或未开个人时间）完全不进这里，旧路径逐位不变。
import { actuate } from './body.mjs';
import { validate } from './rules.mjs';
import { noteAbort } from './action-ledger.mjs';

export const TICK_MINUTES = 60;
export const DAY_MINUTES = 1440;
export const TICK_ACTION_CAP = 4; // 同一角色同一世界刻最多几个动作
export const CHAIN_MAX = 2; // 决策环在同一刻最多再追加几次决策（不含第一次）

// 动作分钟表：设计 §4 的初始参考值，缺省 10 分钟。
export const RESIDENT_MIN = Object.freeze({
  move_to: 5, look_out: 5, talk: 5, gather: 5, forage: 5,
  harvest: 10, plant: 10, plan: 10, deposit: 5, withdraw: 5, exchange: 5,
  eat: 15, rest: 15, house_work: 15, road_lay: 10, road_remove: 10,
  build: 30, till: 30, repair: 30, expand: 30,
  discuss_open: 5, discuss_join: 5, discuss_share: 5, discuss_decline: 5, discuss_leave: 5,
  deafen: 5, seclude: 5, refuse: 5,
});
export const DEFAULT_MINUTES = 10;

// 体力成本：普通劳动先扣 energy（设计 §4）。0 表示不吃体力（移动/社交/进食/休息）。
export const LABOR_ENERGY = Object.freeze({
  gather: 0.03, harvest: 0.05, plant: 0.04, build: 0.10, till: 0.10, repair: 0.06,
  forage: 0.03, expand: 0.12, house_work: 0.06, road_lay: 0.06, road_remove: 0.04,
  deposit: 0.01, withdraw: 0.01, exchange: 0.02,
});
// 施工类：按 30 分钟折一单位劳动落账，打断时已完成的部分不丢。
const STAGED_LABOR_KINDS = new Set(['build']);

export function residentTimeModel(world) {
  return world?.independentWorld === true && world?.survival?.actTimeModel === true;
}

export function residentMinutes(kind) {
  return RESIDENT_MIN[kind] ?? DEFAULT_MINUTES;
}

export function laborEnergy(kind) {
  return LABOR_ENERGY[kind] ?? 0;
}

const dayOf = (world) => Math.floor(world.t / (world.dayTicks ?? 24));

export function clockOf(world, id) {
  const s = world.survival;
  const clock = ((s.actClock ??= {})[id] ??= { day: dayOf(world), usedMin: 0, busy: null });
  const day = dayOf(world);
  if (clock.day !== day) {
    // 跨日：进行中的动作不无限续命，记一条 DAY_END 中止（已落的施工进度留在工地）。
    if (clock.busy) clock.lastAbort = { kind: clock.busy.kind, code: 'DAY_END', at: world.t, progressMin: clock.busy.progressMin, totalMin: clock.busy.totalMin, applied: clock.busy.applied };
    clock.day = day; clock.usedMin = 0; clock.busy = null;
  }
  if (!clock.tick || clock.tick.t !== world.t) clock.tick = { t: world.t, usedMin: 0, n: 0 };
  return clock;
}

export function residentBusy(world, id) {
  return residentTimeModel(world) ? clockOf(world, id).busy : null;
}

export function residentBudget(world, id) {
  const clock = clockOf(world, id);
  return {
    tickLeft: Math.max(0, TICK_MINUTES - clock.tick.usedMin),
    dayLeft: Math.max(0, DAY_MINUTES - clock.usedMin),
    actionsLeft: Math.max(0, TICK_ACTION_CAP - clock.tick.n),
  };
}

// 能不能在同一刻再追加一个动作：活着、没有进行中动作、时刻/当日都有时间、体力没有见底。
export function residentCanChain(world, id) {
  if (!residentTimeModel(world)) return false;
  const a = world.agents?.[id];
  if (!a || a.dead) return false;
  const clock = clockOf(world, id);
  if (clock.busy) return true; // 有进行中动作时也要推进它
  const budget = residentBudget(world, id);
  return budget.tickLeft > 0 && budget.dayLeft > 0 && budget.actionsLeft > 0 && (a.drives?.v?.energy ?? 0) > 0.01;
}

// 开始一个动作：先扣时间；装不下当前刻就转成 busy（不立刻产生效果）。
export function residentBeginTime(world, id, kind) {
  const clock = clockOf(world, id);
  if (clock.busy) return { ok: false, code: 'BUSY' };
  if (clock.tick.n >= TICK_ACTION_CAP) return { ok: false, code: 'TICK_CAP' };
  const cost = residentMinutes(kind);
  if (cost <= 0) { clock.tick.n += 1; return { ok: true, minutes: 0, staged: false }; }
  const tickLeft = Math.max(0, TICK_MINUTES - clock.tick.usedMin);
  const dayLeft = Math.max(0, DAY_MINUTES - clock.usedMin);
  if (dayLeft + 1e-9 < cost) return { ok: false, code: 'TIME_WAIT' };
  clock.tick.n += 1;
  if (tickLeft + 1e-9 >= cost) {
    clock.tick.usedMin += cost;
    clock.usedMin += cost;
    return { ok: true, minutes: cost, staged: false };
  }
  // 装不下本刻：把本刻剩余分钟记进 busy，下一（几）刻继续。
  clock.busy = {
    kind, action: null, startTick: world.t, totalMin: cost, remainMin: cost - tickLeft,
    progressMin: tickLeft, bankedMin: 0, applied: 0,
  };
  clock.tick.usedMin += tickLeft;
  clock.usedMin += tickLeft;
  return { ok: true, minutes: tickLeft, staged: true, remainMin: cost - tickLeft };
}

export function attachBusyAction(world, id, action) {
  const clock = clockOf(world, id);
  if (clock.busy) clock.busy.action = action;
}

export function residentRefundTime(world, id, minutes) {
  if (!(minutes > 0)) return;
  const clock = clockOf(world, id);
  clock.usedMin = Math.max(0, clock.usedMin - minutes);
  clock.tick.usedMin = Math.max(0, clock.tick.usedMin - minutes);
}

function abortBusy(world, id, clock, code) {
  const b = clock.busy;
  clock.busy = null;
  if (!b) return;
  noteAbort(world, 'resident', b.kind); // E2/E3：中止进累计账本
  recordSettlementEvent(world, 'work_interrupted', {
    actor: id, loc: world.loc[id], action: b.kind, reason: code, applied: b.applied,
  });
  clock.lastAbort = { kind: b.kind, code, at: world.t, progressMin: b.progressMin, totalMin: b.totalMin, applied: b.applied };
}

// 每刻推进进行中的动作。返回 {none} | {advanced} | {completed} | {aborted}。
export function advanceResidentBusy(world, id) {
  if (!residentTimeModel(world)) return { none: true };
  const clock = clockOf(world, id);
  const b = clock.busy;
  if (!b) return { none: true };
  const a = world.agents?.[id];
  const cost = laborEnergy(b.kind);
  if (!a || a.dead) { abortBusy(world, id, clock, 'DEAD'); return { aborted: true, code: 'DEAD' }; }
  // 体力门：进行中也可能撑不住，撑不住就中止（进度保留）。
  if (cost > 0 && (a.drives?.v?.energy ?? 0) + 1e-9 < cost) {
    abortBusy(world, id, clock, 'STAMINA');
    return { aborted: true, code: 'STAMINA' };
  }
  // 目标/地点失效：材料没了、工地没了、人被带走了 ⇒ 中止，不重复扣材料。
  if (b.action) {
    const gate = validate(world, id, b.action);
    if (!gate.ok) {
      abortBusy(world, id, clock, gate.code ?? 'INVALID');
      return { aborted: true, code: gate.code ?? 'INVALID' };
    }
  }
  const chunk = Math.min(TICK_MINUTES, b.remainMin);
  clock.tick.usedMin += chunk;
  clock.usedMin += chunk;
  b.progressMin += chunk;
  b.remainMin -= chunk;
  // 施工按 30 分钟落一单位劳动：中断时已完成的部分留在工地上。
  if (STAGED_LABOR_KINDS.has(b.kind)) {
    while (b.bankedMin + 30 <= b.progressMin + 1e-9) {
      const r = actuate(world, id, { ...(b.action ?? { kind: b.kind }), kind: b.kind });
      b.bankedMin += 30;
      if (!r?.ok) {
        abortBusy(world, id, clock, r?.code ?? 'FAILED');
        return { aborted: true, code: r?.code ?? 'FAILED', progressMin: b.progressMin };
      }
      b.applied += 1;
    }
  }
  if (cost > 0) a.drives.v.energy = Math.max(0, a.drives.v.energy - cost * (chunk / Math.max(1, b.totalMin)));
  if (b.remainMin <= 1e-9) {
    let result = null;
    if (!STAGED_LABOR_KINDS.has(b.kind) && b.action) result = actuate(world, id, b.action);
    clock.busy = null;
    return { completed: true, kind: b.kind, applied: b.applied, result };
  }
  return { advanced: true, kind: b.kind, progressMin: b.progressMin, remainMin: b.remainMin };
}

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
import { noteAbort, noteAction, noteRefusal } from './action-ledger.mjs';
import { simMinuteNow } from './sim-clock.mjs';
import { isLaborAction } from './households.mjs';
import { costFor } from './action-cost.mjs';
import { legacyResidentTimeRefusal } from './research-time.mjs';

export const TICK_MINUTES = 60;
export const DAY_MINUTES = 1440;
export const TICK_ACTION_CAP = 4; // 旧路径：同一角色同一世界刻最多几个动作（仅统计；连续路径不再使用）
export const CHAIN_MAX = 2; // 旧路径：决策环在同一刻最多再追加几次决策（连续路径不再使用）

// P1 连续路径：这些动作占用一段连续世界时间（可跨刻），其余动作仍是原子短动作。
// 短动作立即产生效果；长动作在 endMin 到点后结算，开始/完成都不再对齐 tick 边界。
export const CONTINUOUS_LONG_ACTIONS = Object.freeze(['build', 'till', 'repair', 'expand']);
const CONTINUOUS_LONG = new Set(CONTINUOUS_LONG_ACTIONS);

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

export function residentMinutes(kind, world = null) {
  // V7.3.1：正式游戏玩家/居民共用 action-cost 表（0 分钟的休息/睡眠也用共享表，不回退旧值）；
  // 研究态保留旧 RESIDENT_MIN，五份基线逐位不变。
  if (world?.survival?.actTimeModel === true) return costFor(kind).minutes;
  return RESIDENT_MIN[kind] ?? DEFAULT_MINUTES;
}

export function laborEnergy(kind, world = null) {
  // V7.3.1：正式游戏与玩家同取 SHARED_COST；研究态/旧路径保留 LABOR_ENERGY。
  if (world?.survival?.actTimeModel === true) return costFor(kind).energy;
  return LABOR_ENERGY[kind] ?? 0;
}

const dayOf = (world) => Math.floor(world.t / (world.dayTicks ?? 24));

export function clockOf(world, id) {
  const s = world.survival;
  const clock = ((s.actClock ??= {})[id] ??= { day: dayOf(world), usedMin: 0, busy: null });
  const day = dayOf(world);
  if (clock.day !== day) {
    // 跨日：进行中的动作不无限续命，记一条 DAY_END 中止（已落的施工进度留在工地）。
    // V7.3 第三批：与跨刻/死亡中止同口径，补写累计账本与聚落事件；clock.day 更新后天然幂等。
    // P1 连续路径：动作占的是连续区间，跨午夜不应被整数日界砍断 ⇒ 只重置日统计，不清 busy。
    if (clock.busy && !world.simClock) {
      const b = clock.busy;
      clock.lastAbort = { kind: b.kind, code: 'DAY_END', at: world.t, progressMin: b.progressMin, totalMin: b.totalMin, applied: b.applied };
      if (world.gameRules === true) {
        if (id === 'p1') {
          const minutes = Math.max(0, (b.totalMin ?? 0) - (b.remainMin ?? 0));
          recordSettlementEvent(world, 'player_action', {
            actor: 'p1', action: b.kind, status: 'cancelled', code: 'DAY_END',
            minutes, actionId: b.id,
          });
          noteAction(world, 'player', b.kind, false, null, { minutes: 0, labor: isLaborAction(b.kind) });
          noteRefusal(world, 'player', b.kind);
          noteAbort(world, 'player', b.kind);
          s.lastPlayerAbort = { id: b.id, kind: b.kind, code: 'DAY_END', at: world.t, minutesDone: minutes };
        } else {
          noteAbort(world, 'resident', b.kind);
          recordSettlementEvent(world, 'work_interrupted', {
            actor: id, loc: world.loc[id], action: b.kind, reason: 'DAY_END', applied: b.applied,
          });
        }
      }
    }
    clock.day = day; clock.usedMin = 0;
    if (!world.simClock) clock.busy = null;
  }
  if (!clock.tick || clock.tick.t !== world.t) clock.tick = { t: world.t, usedMin: 0, n: 0 };
  // P1：旧档 busy 只有 {startTick, remainMin, progressMin}，连续路径首次取用时补成绝对区间。
  if (world.simClock && clock.busy && !Number.isFinite(clock.busy.endMin)) {
    const nowMin = simMinuteNow(world);
    const progressMin = Math.max(0, Number(clock.busy.progressMin) || 0);
    const remainMin = Math.max(0, Number(clock.busy.remainMin) || 0);
    clock.busy.startMin = nowMin - progressMin;
    clock.busy.endMin = nowMin + remainMin;
    clock.busy.lastAdvanceMin = nowMin;
  }
  return clock;
}

export function residentBusy(world, id) {
  return residentTimeModel(world) ? clockOf(world, id).busy : null;
}

export function residentBudget(world, id) {
  const clock = clockOf(world, id);
  if (world.simClock) {
    // 连续路径：不再有"本刻剩余分钟"这个拒绝条件；日统计保留，tickLeft 仅为视图兼容。
    return {
      tickLeft: Math.max(0, DAY_MINUTES - clock.usedMin),
      dayLeft: Math.max(0, DAY_MINUTES - clock.usedMin),
      actionsLeft: Number.POSITIVE_INFINITY,
    };
  }
  return {
    tickLeft: Math.max(0, TICK_MINUTES - clock.tick.usedMin),
    dayLeft: Math.max(0, DAY_MINUTES - clock.usedMin),
    actionsLeft: Math.max(0, TICK_ACTION_CAP - clock.tick.n),
  };
}

// 能不能在同一刻再追加一个动作：活着、没有进行中动作、时刻/当日都有时间、体力没有见底。
// 连续路径不再"同一刻追加"：决策机会由 ThinkScheduler 按游戏分钟节拍发放，返回 false。
export function residentCanChain(world, id) {
  if (!residentTimeModel(world) || world.simClock) return false;
  const a = world.agents?.[id];
  if (!a || a.dead) return false;
  const clock = clockOf(world, id);
  if (clock.busy) return true; // 有进行中动作时也要推进它
  const budget = residentBudget(world, id);
  return budget.tickLeft > 0 && budget.dayLeft > 0 && (a.drives?.v?.energy ?? 0) > 0.01;
}

// 开始一个动作：先扣时间；旧路径装不下当前刻就转成 busy（不立刻产生效果）。
// 连续路径：短动作立即完成，长动作占用 [startMin,endMin) 的连续区间，到点由 advance 结算。
export function residentBeginTime(world, id, kind) {
  const clock = clockOf(world, id);
  if (clock.busy) return { ok: false, code: 'BUSY' };
  // V7.3.1：TICK_ACTION_CAP 只作调度统计，不再作为“不能行动”的资格上限。
  const cost = residentMinutes(kind, world);
  if (cost <= 0) { clock.tick.n += 1; return { ok: true, minutes: 0, staged: false }; }
  if (world.simClock) {
    clock.tick.n += 1;
    const nowMin = simMinuteNow(world);
    if (!CONTINUOUS_LONG.has(kind)) {
      clock.usedMin += cost;
      clock.tick.usedMin += cost;
      return { ok: true, minutes: cost, staged: false };
    }
    clock.busy = {
      kind, action: null, startTick: world.t, startMin: nowMin, endMin: nowMin + cost,
      lastAdvanceMin: nowMin, totalMin: cost, remainMin: cost,
      progressMin: 0, bankedMin: 0, applied: 0, energyPaid: 0,
    };
    return { ok: true, minutes: 0, staged: true, remainMin: cost };
  }
  const tickLeft = Math.max(0, TICK_MINUTES - clock.tick.usedMin);
  const dayLeft = Math.max(0, DAY_MINUTES - clock.usedMin);
  // 研究态旧路径（world.simClock 关闭）：60 分钟刻 + 1440 日池，装不下就返回研究态旧超时码。
  // 正式连续路径在上一分支已返回，永远走不到这里；字面量只在 research-time.mjs。
  if (dayLeft + 1e-9 < cost) return legacyResidentTimeRefusal();
  clock.tick.n += 1;
  if (tickLeft + 1e-9 >= cost) {
    clock.tick.usedMin += cost;
    clock.usedMin += cost;
    return { ok: true, minutes: cost, staged: false };
  }
  // 装不下本刻：把本刻剩余分钟记进 busy，下一（几）刻继续。
  clock.busy = {
    kind, action: null, startTick: world.t, totalMin: cost, remainMin: cost - tickLeft,
    progressMin: tickLeft, bankedMin: 0, applied: 0, energyPaid: 0,
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
    actor: id, loc: world.loc[id], action: b.kind, reason: code,
    minutesDone: Math.max(0, b.totalMin - b.remainMin), energyPaid: Number((b.energyPaid ?? 0).toFixed(3)),
    applied: b.applied, progressMin: b.progressMin, totalMin: b.totalMin,
  });
  clock.lastAbort = { kind: b.kind, code, at: world.t, progressMin: b.progressMin, totalMin: b.totalMin, applied: b.applied };
}

// 推进进行中的动作。返回 {none} | {advanced} | {completed} | {aborted}。
// 旧路径按"每刻最多 60 分钟"推进；连续路径按分钟调度逐分钟推进（atMin 由 tickSurvPlay 传入）。
export function advanceResidentBusy(world, id, atMin) {
  if (!residentTimeModel(world)) return { none: true };
  const clock = clockOf(world, id);
  const b = clock.busy;
  if (!b) return { none: true };
  const a = world.agents?.[id];
  const cost = laborEnergy(b.kind, world);
  if (!a || a.dead) { abortBusy(world, id, clock, 'DEAD'); return { aborted: true, code: 'DEAD' }; }

  let chunk;
  if (world.simClock) {
    const nowMin = Number.isFinite(atMin) ? atMin : simMinuteNow(world);
    const fromMin = Number.isFinite(b.lastAdvanceMin) ? b.lastAdvanceMin : (b.endMin - b.remainMin);
    const elapsed = Math.max(0, nowMin - fromMin);
    if (elapsed <= 1e-9) return { none: true };
    chunk = Math.min(elapsed, b.remainMin);
    b.lastAdvanceMin = nowMin;
  } else {
    chunk = Math.min(TICK_MINUTES - clock.tick.usedMin, b.remainMin);
  }

  // 体力门：按“本段应付 - 已付”判断（不是整段全额），5+25/10+20 只在钱不够本段时中止。
  const dueAfter = cost * ((b.progressMin + chunk) / Math.max(1, b.totalMin));
  const payDue = Math.max(0, dueAfter - (b.energyPaid ?? 0));
  if (cost > 0 && (a.drives?.v?.energy ?? 0) + 1e-9 < payDue) {
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
  if (cost > 0) {
    // V7.3.1：按“累计应付 - 已付”结算，5+25 与一次 30 分钟总体力一致；
    // progressMin 包含起手时已占用的本刻剩余分钟，第一次推进补扣。
    b.energyPaid ??= 0;
    const due = cost * (b.progressMin / Math.max(1, b.totalMin));
    const pay = Math.max(0, due - b.energyPaid);
    a.drives.v.energy = Math.max(0, a.drives.v.energy - pay);
    b.energyPaid = Number((b.energyPaid + pay).toFixed(6));
  }
  if (b.remainMin <= 1e-9) {
    let result = null;
    if (!STAGED_LABOR_KINDS.has(b.kind) && b.action) result = actuate(world, id, b.action);
    clock.busy = null;
    // V7.3.1：完成必须进累计账本 + 聚落事件；busy 已清空，保证同一动作只结算一次。
    if (result && result.ok === false) {
      noteAction(world, 'resident', b.kind, false, null, { minutes: 0, labor: isLaborAction(b.kind) });
      recordSettlementEvent(world, 'work_interrupted', {
        actor: id, loc: world.loc[id], action: b.kind, reason: result.code ?? 'FAILED',
        minutesDone: b.totalMin, energyPaid: b.energyPaid ?? cost, applied: b.applied, progressMin: b.progressMin, totalMin: b.totalMin,
      });
      return { completed: true, kind: b.kind, applied: b.applied, result };
    }
    noteAction(world, 'resident', b.kind, true, null, {
      minutes: b.totalMin, energy: cost, labor: isLaborAction(b.kind),
    });
    recordSettlementEvent(world, 'work_completed', {
      actor: id, loc: world.loc[id], action: b.kind, status: 'completed',
      minutes: b.totalMin, energy: cost, applied: b.applied, progressMin: b.progressMin,
      actionId: `${id}:${b.kind}:${b.startTick}`,
    });
    return { completed: true, kind: b.kind, applied: b.applied, result };
  }
  return { advanced: true, kind: b.kind, progressMin: b.progressMin, remainMin: b.remainMin };
}

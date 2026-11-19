// 生存玩家动作门面：时间/体力成本、busy 跨刻、失败回滚与账本。
// 具体“能不能做、做了什么”在 survplay-camp；这里只负责预算与生命周期，避免两处各记一套成本。
import { isAlive } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { costFor } from './action-cost.mjs';
import { PLAYER_TIME } from './camp-catalog.mjs';
import { noteAction, noteRefusal, noteAbort, noteCancel, noteSync } from './action-ledger.mjs';
import { recordSettlementEvent } from './settlement-events.mjs';
import { recordConstructionBlock } from './construction-access.mjs';
import { CONSTRUCTION_CODES } from '../shared/camp-construction-access.mjs';
import { facilityOf } from '../shared/camp-facility.mjs';
import { recordRepairFailure } from './production.mjs';
import { isLaborAction } from './households.mjs';
import { playerReach, survActInner } from './survplay-camp.mjs';

// settleSurvival 由 survplay 注入：本模块只调用，不反向持有世界单例。
export function createActionDomain({ settleSurvival }) {
const PLAYER_BUDGET = 100;
const P1_TICK_MINUTES = 60; // 与 resident-time 的 TICK_MINUTES 同源：玩家与居民共用 60 分/刻
function legacyPlayerTime(w, kind) {
  if (!w.independentWorld) return 0;
  if (kind.startsWith('family_')) return 10;
  if (kind === 'camp_exit' || kind === 'camp_sleep' || kind.startsWith('talk_')) return 0;
  return PLAYER_TIME[kind] ?? 0;
}
function budgetLeft(w) {
  const s = w.survival;
  if (s.p1BudgetTick !== w.t) { s.p1BudgetTick = w.t; s.p1BudgetLeft = PLAYER_BUDGET; }
  return s.p1BudgetLeft;
}
// 剩余可行动时间：旧路径仍是本刻 100 点额度；V7.3 正式游戏是本刻 60 分钟池的剩余。
function playerTimeLeft(w) {
  const s = w.survival;
  if (s?.actTimeModel === true) {
    const clock = clockOf(w, 'p1');
    return Math.max(0, P1_TICK_MINUTES - clock.tick.usedMin);
  }
  return s.p1BudgetTick === w.t ? s.p1BudgetLeft : PLAYER_BUDGET;
}
function playerTimeMax(w) {
  return w.survival?.actTimeModel === true ? P1_TICK_MINUTES : PLAYER_BUDGET;
}

// 旧路径（V72_TIME=0）的每刻 100 点预算；正式游戏默认不再使用。
function spendTime(w, cost) {
  if (!w.independentWorld) return true;
  const s = w.survival;
  budgetLeft(w);
  if (s.p1BudgetLeft + 1e-9 < cost) return false;
  s.p1BudgetLeft -= cost;
  return true;
}
function refundTime(w, cost) {
  if (!w.independentWorld || cost <= 0) return;
  budgetLeft(w);
  w.survival.p1BudgetLeft += cost;
}
function refundPlayerMinutes(w, minutes) {
  if (!(minutes > 0)) return;
  const clock = clockOf(w, 'p1');
  clock.tick.usedMin = Math.max(0, clock.tick.usedMin - minutes);
}
function chargePlayerEnergy(w, energy) {
  if (!(energy > 0)) return;
  const a = w.agents.p1;
  if (!a?.drives) return;
  a.drives.v.energy = Math.max(0, a.drives.v.energy - energy);
}

function survAct(sp, body) {
  const w = sp.world, kind = String(body?.kind ?? '');
  // V7.3.2：player_sync 是技术同步，不是劳动：不扣分钟/体力、不占本刻额度、不取消 busy。
  if (kind === 'player_sync') {
    const reach = playerReach(w, body.from);
    noteSync(w, 'player'); // 同步单独计数，不进入劳动账本（成功或被拒都记一次技术同步）
    return reach.ok ? { ok: true, code: 'OK', playerPos: w.survival.playerPos }
      : { ...reach, playerPos: w.survival.playerPos ?? null };
  }
  if (kind === 'busy_cancel') return cancelPlayerBusy(sp);
  const model = w.independentWorld && w.survival?.actTimeModel === true;
  const cost = model ? costFor(kind, body) : { shared: 'legacy', minutes: legacyPlayerTime(w, kind), energy: 0 };
  let spentMinutes = 0;
  const failTime = (code, why) => {
    if (kind === 'repair') playerRepairFailure(w, body, code);
    sp.log.push({ t: w.t, kind, ok: false, code });
    if (sp.log.length > 40) sp.log.shift();
    return { ok: false, code, why };
  };
  if (cost.minutes > 0 || cost.energy > 0) {
    if (model) {
      const clock = clockOf(w, 'p1');
      if (clock.busy) return failTime('BUSY', '手上还有没做完的动作，等它完成');
      if (cost.energy > 0 && (w.agents.p1?.drives?.v?.energy ?? 0) + 1e-9 < cost.energy) {
        return failTime('STAMINA', '体力不够做这件活');
      }
      const left = Math.max(0, P1_TICK_MINUTES - clock.tick.usedMin);
      if (left <= 1e-9) return failTime('TIME_WAIT', '这一拍的时间用完了，等下一拍');
      if (cost.minutes <= left + 1e-9) {
        clock.tick.usedMin += cost.minutes;
        spentMinutes = cost.minutes;
      } else {
        // 装不下本刻剩余分钟：记 busy，下一（几）拍继续；未完成前不产生效果。
        clock.tick.usedMin = P1_TICK_MINUTES;
        clock.busy = {
          id: `p1:${kind}:${w.t}:${clock.tick.n ?? 0}`, kind, body: { ...body }, startTick: w.t,
          totalMin: cost.minutes, remainMin: cost.minutes - left, energyTotal: cost.energy, energyPaid: 0, status: 'running',
        };
        return { ok: true, code: 'BUSY_START', remainMin: cost.minutes - left, why: '本刻只剩这些分钟，剩下的下一拍继续' };
      }
    } else if (!spendTime(w, cost.minutes)) {
      return failTime('ACTION_BUDGET', '本世界刻的可用时间已用完，等下一拍');
    }
  }
  const r = survActInner(sp, body);
  if (kind === 'repair' && !r.ok) playerRepairFailure(w, body, r.code);
  if (!r.ok && Object.hasOwn(CONSTRUCTION_CODES,r.code)) {
    const workTarget = kind==='coop_request' ? body.site : body.target;
    const loc = kind==='build' || kind==='coop_request'
      ? w.survival.sites.find(b=>`work:${b.loc}:${b.type}`===workTarget)?.loc ?? w.loc.p1
      : kind==='move' ? facilityOf(w,body.room)?.loc ?? body.room : body.target ?? w.loc.p1;
    recordConstructionBlock(w,'p1',loc,kind,r.code);
  }
  if (w.independentWorld && r.ok) settleSurvival(sp);
  if (!r.ok && spentMinutes > 0) refundPlayerMinutes(w, spentMinutes);
  if (!r.ok && !model && cost.minutes > 0) refundTime(w, cost.minutes);
  if (model && r.ok && cost.energy > 0) chargePlayerEnergy(w, cost.energy);
  noteAction(sp.world, 'player', body?.kind, !!r?.ok, null, {
    minutes: r?.ok ? spentMinutes : 0,
    energy: model && r?.ok ? cost.energy : 0,
    labor: isLaborAction(body?.kind),
  });
  if (r && !r.ok) noteRefusal(sp.world, 'player', body?.kind);
  return r;
}

function playerRepairFailure(w, body, code) {
  const loc = Object.hasOwn(body, 'from')
    ? w.survival.buildings.find(b => `work:${b.loc}:${b.type}` === body.target)?.loc
    : w.loc.p1;
  recordRepairFailure(w, 'p1', loc, code);
}

// V7.3 第三批：中止/取消进行中的动作（只结束 busy，不结算效果、不退已用分钟、不重复扣体力）。
function playerBusyAbort(sp, code) {
  const w = sp.world, clock = clockOf(w, 'p1'), b = clock?.busy;
  if (!b) return;
  const userCancel = code === 'USER_CANCEL';
  clock.busy = null;
  recordSettlementEvent(w, 'player_action', {
    actor: 'p1', action: b.kind,
    status: userCancel ? 'cancelled' : 'aborted',
    code: userCancel ? 'USER_CANCEL' : code,
    minutesDone: b.totalMin - b.remainMin, actionId: b.id,
  });
  if (userCancel) {
    noteCancel(w, 'player', b.kind);
    noteAbort(w, 'player', b.kind);
    noteAction(w, 'player', b.kind, false, null, { minutes: 0, labor: isLaborAction(b.kind) });
  } else {
    noteAction(w, 'player', b.kind, false, null, { minutes: 0, labor: isLaborAction(b.kind) });
    noteRefusal(w, 'player', b.kind);
    noteAbort(w, 'player', b.kind);
  }
  w.survival.lastPlayerAbort = { id: b.id, kind: b.kind, code: userCancel ? 'CANCELLED' : code, at: w.t, minutesDone: b.totalMin - b.remainMin };
  sp.log.push({ t: w.t, kind: b.kind, ok: false, code: userCancel ? 'CANCELLED' : code });
  if (sp.log.length > 40) sp.log.shift();
}
// V7.3 第三批：玩家主动取消进行中的 busy（幂等；无 busy ⇒ NO_BUSY）。
function cancelPlayerBusy(sp) {
  const w = sp?.world;
  if (w?.independentWorld !== true || w?.survival?.actTimeModel !== true) return { ok: false, code: 'NO_BUSY' };
  const b = clockOf(w, 'p1')?.busy;
  if (!b) return { ok: false, code: 'NO_BUSY' };
  playerBusyAbort(sp, 'USER_CANCEL');
  return { ok: true, code: 'OK', cancelled: b.kind };
}

// 玩家跨刻动作：每拍按剩余分钟推进；完成时只结算一次（busy 先清空再执行）。
function advancePlayerBusy(sp) {
  const w = sp.world, s = w.survival;
  if (s?.actTimeModel !== true || !w.independentWorld) return;
  const clock = clockOf(w, 'p1');
  const b = clock.busy;
  if (!b) return;
  if (!isAlive(w.agents.p1)) { playerBusyAbort(sp, 'DEAD'); return; }
  const left = Math.max(0, P1_TICK_MINUTES - clock.tick.usedMin);
  const chunk = Math.min(left, b.remainMin);
  clock.tick.usedMin += chunk;
  b.remainMin -= chunk;
  if (b.remainMin > 1e-9) return;
  clock.busy = null;
  const r = survActInner(sp, b.body);
  if (r?.ok) {
    chargePlayerEnergy(w, b.energyTotal);
    if (w.independentWorld) settleSurvival(sp);
    recordSettlementEvent(w, 'player_action', { actor: 'p1', action: b.kind, status: 'completed', minutes: b.totalMin, actionId: b.id });
    noteAction(w, 'player', b.kind, true, null, { minutes: b.totalMin, energy: b.energyTotal, labor: isLaborAction(b.kind) });
    sp.log.push({ t: w.t, kind: b.kind, ok: true, code: r.code ?? 'OK' });
  } else {
    recordSettlementEvent(w, 'player_action', { actor: 'p1', action: b.kind, status: 'aborted', code: r?.code ?? 'FAILED', minutes: b.totalMin, actionId: b.id });
    noteAction(w, 'player', b.kind, false, null, { minutes: 0, labor: isLaborAction(b.kind) });
    noteRefusal(w, 'player', b.kind);
    s.lastPlayerAbort = { id: b.id, kind: b.kind, code: r?.code ?? 'FAILED', at: w.t, minutesDone: b.totalMin };
    sp.log.push({ t: w.t, kind: b.kind, ok: false, code: r?.code ?? 'FAILED' });
  }
  if (sp.log.length > 40) sp.log.shift();
}

  return { survAct, cancelPlayerBusy, advancePlayerBusy, playerTimeLeft, playerTimeMax };
}

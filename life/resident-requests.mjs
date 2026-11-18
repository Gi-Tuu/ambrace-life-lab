// SOC-01：居民可以主动向玩家提出请求；玩家可以接受或拒绝。
// 只在游戏态生效（world.gameRules），研究/历史路径不受影响。
// 请求是对世界真实资源的索取：食物来自玩家所在私宅餐台，木料来自玩家背包。

import { householdAccess } from './home-access.mjs';
import { recordSettlementEvent } from './settlement-events.mjs';
import { noteConsumed } from './resource-ledger.mjs';

function recordRequest(world, req, result, delivered, reason) {
  const to = req.to ?? 'p1';
  recordSettlementEvent(world, 'resource_request', {
    requestId: req.id, actor: req.from, target: to, loc: world.loc[req.from], result, startedAt: req.t,
    resource: req.kind === 'food' ? 'food' : 'wood', ...(delivered && { delivered }), ...(reason && { reason }),
  });
}

export const REQUEST_KINDS = Object.freeze(['food', 'material']);
export const REQUEST_TTL = 48; // 两个游戏日；过期请求不能再兑现

const FOOD_KINDS = ['crop', 'berry', 'fruit', 'egg', 'milk', 'meat'];

function dayOf(w) {
  return Math.floor((w.t ?? 0) / (w.dayTicks ?? 24));
}

// 每刻最多生成一条：同屋、且该居民今日还没提过、且有具体缺口（饿 或 没有木料）。
export function maybeResidentRequest(world) {
  const s = world.survival;
  if (!world.gameRules || !s?.households) return null;
  if (world.agents?.p1?.dead) return null; // 玩家死后不再生成"请你分我一份"的请求
  const day = dayOf(world);
  s.requests ??= [];
  // V7.1：过期请求自动清理（此前只有"回应时"才判过期，请求条会堆同一个人的多条）。
  s.requests = s.requests.filter((r) => {
    if ((world.t ?? 0) - (r.t ?? 0) > REQUEST_TTL) {
      recordRequest(world, r, 'expired');
      return false;
    }
    if (!world.agents[r.from] || world.agents[r.from].dead) {
      recordRequest(world, r, 'cancelled', null, 'REQUESTER_GONE');
      return false;
    }
    return true;
  }); // 死者请求不再占 HUD
  if (s.requestsDay !== day) {
    s.requestsDay = day;
    s.requestsAsked = {};
  }
  s.requestsAsked ??= {};
  const here = world.loc.p1;
  for (const a of Object.values(world.agents)) {
    if (a.isPlayer || a.dead) continue;
    if (world.loc[a.id] !== here) continue;
    if (s.requestsAsked[a.id] === day) continue;
    if (s.requests.some((r) => r.from === a.id)) continue; // 同一居民只保留一条未回应请求
    const hungry = (a.drives?.v?.energy ?? 1) < 0.4;
    const noWood = (world.pinv?.[a.id]?.wood ?? 0) < 1;
    if (!hungry && !noWood) continue;
    const kind = hungry ? 'food' : 'material';
    const req = {
      id: `r${world.t}:${a.id}`,
      t: world.t,
      from: a.id,
      name: a.name,
      kind,
      text: kind === 'food' ? `${a.name}：能分我一点吃的吗？` : `${a.name}：能借我一根木头吗？`,
    };
    s.requests.push(req);
    recordRequest(world, req, 'opened');
    if (s.requests.length > 6) recordRequest(world, s.requests.shift(), 'cancelled', null, 'REQUEST_LIMIT');
    s.requestsAsked[a.id] = day;
    return req;
  }
  return null;
}

// 玩家回应：accept=true 兑现资源并加信任；false 明确拒绝并扣信任。两者都清掉请求。
export function respondRequest(world, body) {
  const s = world.survival;
  const list = s?.requests ?? [];
  const at = list.findIndex((r) => r.id === body?.id);
  if (at < 0) return { ok: false, code: 'NO_REQUEST' };
  const req = list[at];
  const npc = world.agents[req.from];
  if (!npc || npc.dead) {
    list.splice(at, 1);
    recordRequest(world, req, 'cancelled', null, 'REQUESTER_GONE');
    return { ok: false, code: 'REQUESTER_GONE' };
  }
  // 在途（跨区行走）的人不能隔空收东西：等他到达或过期。
  if (s.districtTravel?.[req.from]) return { ok: false, code: 'REQUESTER_AWAY', request: req };
  // V7.1 P1：过期请求不可兑现（请求是当时的缺口，不是长期欠条）。
  if ((world.t ?? 0) - (req.t ?? 0) > REQUEST_TTL) {
    list.splice(at, 1);
    s.requestsResolved = (s.requestsResolved ?? 0) + 1;
    recordRequest(world, req, 'expired');
    return { ok: false, code: 'REQUEST_EXPIRED', request: req };
  }
  const accept = body?.accept === true;
  // V7.1：分食先查"本人是否在可用的餐台"（比距离更具体），材料则先查距离。
  if (accept && req.kind === 'food' && s.settlementLife) {
    const home = world.campPlayerRoom;
    if (!home || (home !== 'home' && !householdAccess(world, 'p1', home))) {
      return { ok: false, code: 'NOT_HOME' };
    }
  }
  // V7.1 P1：交付要当面。远距离只能算"传话"，不能把资源直接送到对方手里。
  if (world.loc.p1 !== world.loc[req.from]) {
    return { ok: false, code: 'TOO_FAR', request: req };
  }
  let delivered;
  if (accept) {
    if (req.kind === 'food') {
      const home = s.settlementLife ? world.campPlayerRoom : world.loc.p1;
      const bin = s.campContainers?.[`${home}:meal`];
      const item = bin && FOOD_KINDS.find((k) => (bin[k] ?? 0) > 0);
      if (!item) return { ok: false, code: 'NO_FOOD' };
      bin[item] -= 1;
      noteConsumed(world, item, 'residentRequest', 1);
      delivered = { item, amount: 1 };
      npc.viab?.regen?.(0.5);
      npc.drives?.reward?.('energy', 0.35);
    } else {
      if ((world.pinv?.p1?.wood ?? 0) < 1) return { ok: false, code: 'NO_WOOD' };
      world.pinv.p1.wood -= 1;
      world.pinv[req.from] ??= { wood: 0, stone: 0 };
      world.pinv[req.from].wood += 1;
      delivered = { item: 'wood', amount: 1 };
    }
    npc.relations?.meet?.('p1', world.t, { delta: { trust: 3, familiarity: 0.03 } });
  } else {
    npc.relations?.meet?.('p1', world.t, { delta: { trust: -2 } });
  }
  list.splice(at, 1);
  s.requestsResolved = (s.requestsResolved ?? 0) + 1;
  if (accept) s.requestsGranted = (s.requestsGranted ?? 0) + 1;
  recordRequest(world, req, accept ? 'delivered' : 'declined', delivered);
  return { ok: true, code: accept ? 'ACCEPTED' : 'DECLINED', request: req };
}
// V7.1 §5.10：居民之间也能借资源（当前只做木料，同屋 + 双向信任 + 每日一次）。
export const PEER_REQUEST_TTL = 24;

export function maybePeerRequest(world) {
  const s = world.survival;
  if (!world.gameRules || !s) return null;
  s.peerRequests ??= [];
  const day = Math.floor((world.t ?? 0) / (world.dayTicks ?? 24));
  if (s.peerRequestsDay !== day) { s.peerRequestsDay = day; s.peerAsked = {}; }
  s.peerAsked ??= {};
  for (const a of Object.values(world.agents)) {
    if (a.isPlayer || a.dead) continue;
    if (s.peerAsked[a.id] === day) continue;
    if ((world.pinv?.[a.id]?.wood ?? 0) >= 1) continue;
    if (s.districtTravel?.[a.id]) continue; // 在途不开口
    const mate = Object.values(world.agents).find((b) => !b.isPlayer && !b.dead && b.id !== a.id && !s.districtTravel?.[b.id] &&
      world.loc[b.id] === world.loc[a.id] && (world.pinv?.[b.id]?.wood ?? 0) >= 2 &&
      (a.relations?.get?.(b.id)?.trust ?? 0) >= 40);
    if (!mate) continue;
    const req = { id: `p${world.t}:${a.id}:${mate.id}`, t: world.t, from: a.id, to: mate.id, kind: 'wood', text: `${a.name}：能借我一根木头吗？` };
    s.peerRequests.push(req);
    recordRequest(world, req, 'opened');
    if (s.peerRequests.length > 8) recordRequest(world, s.peerRequests.shift(), 'cancelled', null, 'REQUEST_LIMIT');
    s.peerAsked[a.id] = day;
    return req;
  }
  return null;
}

// 被请求者按信任裁决：≥35 就借并互加信任；否则拒绝并扣一点信任。过期或走散都不交付。
export function stepPeerRequests(world) {
  const s = world.survival;
  const list = s?.peerRequests ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i];
    const from = world.agents[r.from], to = world.agents[r.to];
    if (!from || !to || from.dead || to.dead) {
      list.splice(i, 1);
      recordRequest(world, r, 'cancelled', null, 'PARTICIPANT_GONE');
      continue;
    }
    if ((world.t ?? 0) - (r.t ?? 0) > PEER_REQUEST_TTL) {
      list.splice(i, 1);
      s.peerRequestsExpired = (s.peerRequestsExpired ?? 0) + 1;
      recordRequest(world, r, 'expired');
      continue;
    }
    if (world.loc[from.id] !== world.loc[to.id]) continue; // 走散了：等重聚或过期，不隔空交付
    if (s.districtTravel?.[from.id] || s.districtTravel?.[to.id]) continue; // 在途不交付
    const trusted = (to.relations?.get?.(from.id)?.trust ?? 0) >= 35;
    if (!trusted || !((world.pinv?.[to.id]?.wood ?? 0) >= 1)) {
      from.relations?.meet?.(to.id, world.t, { delta: { trust: -1 } });
      list.splice(i, 1);
      s.peerRequestsRefused = (s.peerRequestsRefused ?? 0) + 1;
      recordRequest(world, r, 'declined', null, trusted ? 'NO_WOOD' : 'LOW_TRUST');
      continue;
    }
    world.pinv[to.id].wood -= 1;
    world.pinv[from.id] ??= { wood: 0, stone: 0 };
    world.pinv[from.id].wood += 1;
    from.relations?.meet?.(to.id, world.t, { delta: { trust: 2, familiarity: 0.02 } });
    to.relations?.meet?.(from.id, world.t, { delta: { trust: 1, familiarity: 0.02 } });
    list.splice(i, 1);
    s.peerRequestsGranted = (s.peerRequestsGranted ?? 0) + 1;
    recordRequest(world, r, 'delivered', { item: 'wood', amount: 1 });
  }
}

// SOC-01：居民可以主动向玩家提出请求；玩家可以接受或拒绝。
// 只在游戏态生效（world.gameRules），研究/历史路径不受影响。
// 请求是对世界真实资源的索取：食物来自玩家所在私宅餐台，木料来自玩家背包。

export const REQUEST_KINDS = Object.freeze(['food', 'material']);

const FOOD_KINDS = ['crop', 'berry', 'fruit', 'egg', 'milk', 'meat'];

function dayOf(w) {
  return Math.floor((w.t ?? 0) / (w.dayTicks ?? 24));
}

// 每刻最多生成一条：同屋、且该居民今日还没提过、且有具体缺口（饿 或 没有木料）。
export function maybeResidentRequest(world) {
  const s = world.survival;
  if (!world.gameRules || !s?.households) return null;
  const day = dayOf(world);
  s.requests ??= [];
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
    if (s.requests.length > 6) s.requests.shift();
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
  if (!npc || npc.dead) { list.splice(at, 1); return { ok: false, code: 'REQUESTER_GONE' }; }
  const accept = body?.accept === true;
  if (accept) {
    if (req.kind === 'food') {
      const home = s.settlementLife ? (world.campPlayerRoom ?? world.loc.p1) : world.loc.p1;
      const bin = s.campContainers?.[`${home}:meal`];
      const item = bin && FOOD_KINDS.find((k) => (bin[k] ?? 0) > 0);
      if (!item) return { ok: false, code: 'NO_FOOD' };
      bin[item] -= 1;
      npc.viab?.regen?.(0.5);
      npc.drives?.reward?.('energy', 0.35);
    } else {
      if ((world.pinv?.p1?.wood ?? 0) < 1) return { ok: false, code: 'NO_WOOD' };
      world.pinv.p1.wood -= 1;
      world.pinv[req.from] ??= { wood: 0, stone: 0 };
      world.pinv[req.from].wood += 1;
    }
    npc.relations?.meet?.('p1', world.t, { delta: { trust: 3, familiarity: 0.03 } });
  } else {
    npc.relations?.meet?.('p1', world.t, { delta: { trust: -2 } });
  }
  list.splice(at, 1);
  s.requestsResolved = (s.requestsResolved ?? 0) + 1;
  if (accept) s.requestsGranted = (s.requestsGranted ?? 0) + 1;
  return { ok: true, code: accept ? 'ACCEPTED' : 'DECLINED', request: req };
}

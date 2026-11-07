// S4 场景包：schema 校验 + 装载自检。
// 自检是轻量收支仿真（不是引擎全量仿真）：它的职责是拦下"经济上不可能活"或"经济上不可能死"的包，
// 行为保真由 S2/S3 的轨迹一致闸门与既有判据负责。两件事分开，才不至于用假精度换真沉默。
import { generateAffordances, makeWorldFromPack, validateAction, applyEffect, PREDICATES } from './capability.mjs';

export const PACK_REQUIRED = ['id', 'version', 'locs', 'things', 'verbs', 'drives', 'economy'];
export const ECONOMY_REQUIRED = ['upkeep', 'costScale', 'mealYield', 'mealMin', 'thresholds'];

export function validatePack(pack) {
  const errors = [];
  for (const f of PACK_REQUIRED) if (pack?.[f] === undefined) errors.push(`缺必填段「${f}」`);
  if (errors.length) return { ok: false, errors };

  for (const f of ECONOMY_REQUIRED) if (pack.economy?.[f] === undefined) errors.push(`economy 缺「${f}」：没有校准段的包不允许装载`);

  const knownPreds = new Set(Object.keys(PREDICATES));
  const capPool = new Set();
  for (const t of pack.things) for (const c of Object.keys(t.props ?? {})) capPool.add(c);

  for (const v of pack.verbs) {
    if (!v.id) { errors.push('动词缺 id'); continue; }
    if (v.cost === undefined || v.impulse === undefined) errors.push(`动词「${v.id}」缺 cost/impulse：不进比较的量没有后果`);
    if (!v.effect) errors.push(`动词「${v.id}」缺 effect`);
    const needs = Array.isArray(v.needs) ? v.needs : v.needs ? [v.needs] : [];
    for (const n of needs) if (!capPool.has(n)) errors.push(`动词「${v.id}」要求能力「${n}」，但没有任何对象具备 ⇒ 死配置`);
    for (const p of v.pre ?? []) {
      const name = Object.keys(p)[0];
      if (!knownPreds.has(name)) errors.push(`动词「${v.id}」使用未知谓词「${name}」`);
    }
    for (const m of String(v.idFormat ?? '').matchAll(/\{(\w+)\}/g)) {
      if (!['owner', 'loc', 'id'].includes(m[1])) errors.push(`动词「${v.id}」idFormat 占位符「${m[1]}」不被支持`);
    }
  }

  for (const t of pack.things) {
    if (t.loc && pack.locs[t.loc] === undefined) errors.push(`对象「${t.id}」位于未声明的地点「${t.loc}」`);
    if (t.owner && pack.agents && pack.agents[t.owner] === undefined) errors.push(`对象「${t.id}」归属未声明的角色「${t.owner}」`);
  }

  return { ok: !errors.length, errors };
}

// 确定性贪心：饿了先吃够的，不饿做最便宜的事。目的只是把收支跑出来，不冒充行为模型。
function greedy(world, pack, agentId, v, setpoint, params) {
  const agent = { id: agentId };
  const acts = generateAffordances({ pack, world, agent, params });
  if (!acts.length) return null;
  const hungry = v < setpoint;
  // mealMin 比较的是**份量**（引擎里是 viab.ate），不是折算后的收益
  const feed = acts.filter((a) => Number(a.portion ?? 0) * pack.economy.mealYield > 0 && Number(a.portion ?? 0) >= pack.economy.mealMin);
  const pick = hungry && feed.length
    ? feed.sort((x, y) => x.cost - y.cost || (x.id < y.id ? -1 : 1))[0]
    : acts.sort((x, y) => x.cost - y.cost || (x.id < y.id ? -1 : 1))[0];
  return { agent, act: pick };
}

export function selfCheck(pack, { seed = 7, ticks = 1200 } = {}) {
  const v = validatePack(pack);
  if (!v.ok) return { ok: false, errors: v.errors };

  const e = pack.economy;
  const ids = Object.keys(pack.agents ?? { a1: {} });
  const world = makeWorldFromPack(pack, ids);
  const params = pack.params ?? {};
  const dayTicks = pack.dayTicks ?? 24;
  const nightStart = pack.nightAt ?? 20;
  const st = Object.fromEntries(ids.map((id) => [id, { v: 1, stage: 0, eats: 0, actions: 0, spent: 0, gained: 0 }]));

  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.isNight = t % dayTicks >= nightStart;
    for (const r of pack.regen ?? []) {
      if (t % r.every === 0) world.things[r.thing].qty = Math.min(r.max ?? Infinity, world.things[r.thing].qty + r.add);
    }
    for (const id of ids) {
      const s = st[id];
      const picked = greedy(world, pack, id, s.v, pack.drives?.energy?.setpoint ?? 0.55, params);
      if (!picked) { s.v -= e.upkeep; continue; }
      const { act } = picked;
      const verb = pack.verbs.find((x) => x.id === act.kind);
      const check = validateAction({ pack, world, agent: { id }, intent: act, params });
      if (!check.ok) { s.v -= e.upkeep; continue; }
      const res = applyEffect({ pack, world, agent: { id }, intent: act, params });
      if (!res.ok) { s.v -= e.upkeep; continue; }
      s.actions += 1;
      s.spent += e.costScale * act.cost;
      if (res.satiated === 'energy' && Number(res.amount) >= e.mealMin) {
        s.gained += Number(res.amount) * e.mealYield;
        s.eats += 1;
        s.v = Math.min(1, s.v + Number(res.amount) * e.mealYield);
      }
      s.v -= e.upkeep + e.costScale * act.cost;
      s.v = Math.max(0, s.v);
      while (s.stage < e.thresholds.length && s.v < e.thresholds[s.stage]) s.stage += 1;
    }
  }

  const rows = ids.map((id) => ({ 角色: id, 末存续: Number(st[id].v.toFixed(3)), 掉档: st[id].stage, 进食: st[id].eats, 动作: st[id].actions }));
  const canCollapse = rows.some((r) => r.掉档 >= 1);
  const canSurvive = rows.some((r) => r.末存续 >= (e.thresholds[0] ?? 0.5));
  const per100 = Number(((rows.reduce((s, r) => s + r.动作, 0) / ids.length / ticks) * 100).toFixed(2));
  const eventRateOk = per100 > 0;
  const ok = canCollapse && canSurvive && eventRateOk;
  return {
    ok,
    verdict: { 可垮: canCollapse, 可活: canSurvive, 每百刻动作数: per100, 事件率合理: eventRateOk },
    rows,
    note: '轻量收支自检：可垮与可活必须同时成立，否则世界要么是必死、要么是永生，两者都不能支撑"存续由选择决定"的主张',
  };
}

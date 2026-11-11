// 生产建设层（Phase B）。服务端权威：资源库存、建筑选址/材料/工时/功能/损坏/维修。
// 只作用于 world.survival（preset=survival）；lab/town 无此字段 ⇒ 逐位不变。
// 建筑功能以"生效修正"形式回灌生存循环（worldstate 读取），损坏即失效、维修恢复。
import { siteOf } from './geometry.mjs';
import { dayOf, seasonOf } from './clock.mjs';

export const BUILDINGS = Object.freeze({
  shelter: { label: '住所', cost: { wood: 4, stone: 2 }, labor: 6, desc: '降低饥饿压力' },
  granary: { label: '储粮设施', cost: { wood: 5, stone: 3 }, labor: 6, desc: '提高粮仓上限' },
  workshop: { label: '生产设施', cost: { wood: 6, stone: 4 }, labor: 8, desc: '提高菜畦产量' },
  wall: { label: '防护设施', cost: { wood: 3, stone: 6 }, labor: 8, desc: '减轻天气对建筑的损耗' },
});
export const GATHER_BY_LOC = Object.freeze({ yard: 'wood', garden: 'wood', watch: 'stone', well: 'stone' });
export const LABOR_PER_ACTION = 2;

export function initProduction(s) {
  s.inv = { wood: 0, stone: 0 };
  s.sites = [];      // {type, at:[x,y], loc, progress}
  s.buildings = [];  // {type, at, loc, integrity:1}
}

const atLoc = (list, loc) => list.find((b) => b.loc === loc);
export const functional = (b) => b.integrity > 0;

// 生效修正：只统计完好建筑。worldstate 每日读取，损坏自动失效。
export function effectiveMods(world) {
  const bs = (world.survival?.buildings ?? []).filter(functional);
  const has = (t) => bs.some((b) => b.type === t);
  return {
    storeCap: 24 + (has('granary') ? 12 : 0),
    yieldBonus: has('workshop') ? 1 : 0,
    pressureMul: has('shelter') ? 0.5 : 1,
    shield: has('wall'),
  };
}

export function doGather(world, agentId) {
  const res = GATHER_BY_LOC[world.loc[agentId]] ?? 'wood';
  const bag = (world.pinv ??= {})[agentId] ??= { wood: 0, stone: 0 }; // §15 P2-C 背包：采集入个人包
  bag[res] += 2;
  return { ok: true, code: 'OK', res, amount: 2 };
}
// §15 P2-C 集体劳动：coop 采集归公仓（个人包→公仓），供合作阶段检查与奠基消耗
export function coopPoolGather(world, agentId) {
  const r = doGather(world, agentId);
  const bag = world.pinv?.[agentId];
  if (bag) { world.survival.inv[r.res] += bag[r.res]; bag[r.res] = 0; }
  return r;
}

export function doPlan(world, agentId, type) {
  const s = world.survival;
  const def = BUILDINGS[type];
  if (!def) return { ok: false, code: 'NO_TYPE' };
  const loc = world.loc[agentId];
  if (!(world.outdoor ?? []).includes(loc)) return { ok: false, code: 'NOT_OUTDOOR' };
  if (atLoc(s.sites, loc) || atLoc(s.buildings, loc)) return { ok: false, code: 'OCCUPIED' };
  const bag = (world.pinv ?? {})[agentId] ?? { wood: 0, stone: 0 }; // §15 P2-C 背包优先、公仓兜底
  if (bag.wood + s.inv.wood < def.cost.wood || bag.stone + s.inv.stone < def.cost.stone) return { ok: false, code: 'NO_MATERIAL' };
  const bw = Math.min(bag.wood, def.cost.wood); bag.wood -= bw; s.inv.wood -= def.cost.wood - bw;
  const bs = Math.min(bag.stone, def.cost.stone); bag.stone -= bs; s.inv.stone -= def.cost.stone - bs;
  s.sites.push({ type, loc, at: siteOf(loc) ?? [0, 0], progress: 0 });
  return { ok: true, code: 'OK' };
}

export function doBuild(world, agentId) {
  const s = world.survival;
  const site = atLoc(s.sites, world.loc[agentId]);
  if (!site) return { ok: false, code: 'NO_SITE' };
  site.progress += LABOR_PER_ACTION;
  if (site.progress >= BUILDINGS[site.type].labor) {
    s.sites = s.sites.filter((x) => x !== site);
    s.buildings.push({ type: site.type, loc: site.loc, at: site.at, integrity: 1 });
    return { ok: true, code: 'OK', completed: site.type };
  }
  return { ok: true, code: 'OK', completed: null, progress: site.progress };
}

export function doRepair(world, agentId) {
  const s = world.survival;
  const b = atLoc(s.buildings, world.loc[agentId]);
  if (!b || b.integrity >= 1) return { ok: false, code: 'NO_REPAIR' };
  const bag = (world.pinv ?? {})[agentId] ?? { wood: 0, stone: 0 }; // §15 P2-C 背包优先、公仓兜底
  if (bag.wood + s.inv.wood < 1 || bag.stone + s.inv.stone < 1) return { ok: false, code: 'NO_MATERIAL' };
  const bw = Math.min(bag.wood, 1); bag.wood -= bw; s.inv.wood -= 1 - bw;
  const bs = Math.min(bag.stone, 1); bag.stone -= bs; s.inv.stone -= 1 - bs;
  b.integrity = 1;
  return { ok: true, code: 'OK' };
}

// 每日天气损耗（确定性，不用 Math.random）：雨/寒扣完好度，wall 庇护减轻。
export function dailyWear(world, mods) {
  const s = world.survival;
  if (!s || (world.weather !== 'rain' && world.weather !== 'cold')) return;
  const base = (world.survival.wearRate ?? 0.1) * [1.0, 1.0, 1.1, 1.5][seasonOf(dayOf(world.t))]; // §15 P2-B 四季调制损耗（冬更苛）
  const rate = mods.shield ? base * 0.4 : base;
  for (const b of s.buildings) b.integrity = Math.max(0, Number((b.integrity - rate).toFixed(2)));
}
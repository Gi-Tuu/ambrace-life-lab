// 生产建设层（Phase B）。服务端权威：资源库存、建筑选址/材料/工时/功能/损坏/维修。
// 只作用于 world.survival（preset=survival）；lab/town 无此字段 ⇒ 逐位不变。
// 建筑功能以"生效修正"形式回灌生存循环（worldstate 读取），损坏即失效、维修恢复。
import { siteOf } from './geometry.mjs';
import { constructionLot, overlapsLot } from '../web/camp-layout.mjs';
import { dayOf, seasonOf } from './clock.mjs';
import { residentStage } from './households.mjs';

export const BUILDINGS = Object.freeze({
  shelter: { label: '住所', cost: { wood: 4, stone: 2 }, labor: 6, desc: '降低饥饿压力' },
  granary: { label: '储粮设施', cost: { wood: 5, stone: 3 }, labor: 6, desc: '提高粮仓上限' },
  workshop: { label: '生产设施', cost: { wood: 6, stone: 4 }, labor: 8, desc: '提高菜畦产量' },
  wall: { label: '防护设施', cost: { wood: 3, stone: 6 }, labor: 8, desc: '减轻天气对建筑的损耗' },
});
export const GATHER_BY_LOC = Object.freeze({ yard: 'wood', garden: 'wood', watch: 'stone', well: 'stone' });
export const LABOR_PER_ACTION = 2;

// P0-3 轻量资源储量：每个采集地点一份可耗尽的账，采集扣减、随世界时间再生。
// 木料地点与树木砍伐/再生同步（camp_chop 扣同一份账、树再生时回补）；石料地点按日缓慢恢复。
export const RES_STOCK = Object.freeze({ yard: 12, garden: 6, watch: 10, well: 10 });
export const RES_REGEN = 1; // 每游戏日每地点恢复量（上限＝初始储量）

export function initProduction(s) {
  s.inv = { wood: 0, stone: 0 };
  s.sites = [];      // {type, at:[x,y], loc, progress}
  s.buildings = [];  // {type, at, loc, integrity:1}
  s.resStock = { ...RES_STOCK };
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
  const s = world.survival;
  const loc = world.loc[agentId];
  const res = GATHER_BY_LOC[loc];
  if (!res) return { ok: false, code: 'NOT_GATHER_LOC' }; // P0-3：无资源地点不能采集
  const stock = (s.resStock ??= { ...RES_STOCK });
  const have = stock[loc] ?? 0;
  if (have <= 0) return { ok: false, code: 'NO_RESOURCE' }; // 采空了，等再生
  const take = Math.min(residentStage(world, agentId) === 'elder' ? 1 : 2, have); // P1-1：老年体力下降，采集减产
  stock[loc] = have - take;
  const bag = (world.pinv ??= {})[agentId] ??= { wood: 0, stone: 0 }; // §15 P2-C 背包：采集入个人包
  bag[res] += take;
  return { ok: true, code: 'OK', res, amount: take };
}

// P0-3 资源再生（日界调用）：每地点 +RES_REGEN 封顶初始储量；被砍的树再生时回补木料账。
export function regenResources(world) {
  const s = world.survival;
  const stock = (s.resStock ??= { ...RES_STOCK });
  for (const loc of Object.keys(RES_STOCK)) stock[loc] = Math.min(RES_STOCK[loc], (stock[loc] ?? 0) + RES_REGEN);
  // 树木视觉与资源账同源：regrowAt 到期 ⇒ 树成熟并回补 2 木料（与 camp_chop 扣减对称），随后清零。
  const trees = s.campTrees;
  if (trees) {
    const grove = world.campLayout?.grove ?? [];
    for (const tree of grove) {
      const at = trees[tree.id] ?? 0;
      if (at > 0 && at <= world.t) {
        const loc = tree.site;
        if (GATHER_BY_LOC[loc] === 'wood') stock[loc] = Math.min(RES_STOCK[loc] ?? 12, (stock[loc] ?? 0) + 2);
        trees[tree.id] = 0;
      }
    }
  }
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
  const lot=constructionLot(loc,world.campLayout);
  if (!lot) return {ok:false,code:'NO_LOT'};
  if ([...s.sites,...s.buildings].some(b=>{
    const occupied=b.lot??constructionLot(b.loc,world.campLayout);
    return b.loc===loc || occupied && overlapsLot(lot,occupied,.35);
  })) return {ok:false,code:'OCCUPIED'};
  const bag = (world.pinv ?? {})[agentId] ?? { wood: 0, stone: 0 }; // §15 P2-C 背包优先、公仓兜底
  if (bag.wood + s.inv.wood < def.cost.wood || bag.stone + s.inv.stone < def.cost.stone) return { ok: false, code: 'NO_MATERIAL' };
  const bw = Math.min(bag.wood, def.cost.wood); bag.wood -= bw; s.inv.wood -= def.cost.wood - bw;
  const bs = Math.min(bag.stone, def.cost.stone); bag.stone -= bs; s.inv.stone -= def.cost.stone - bs;
  s.sites.push({ type, loc, at: siteOf(loc,world.campLayout), lot, progress: 0 });
  return { ok: true, code: 'OK' };
}

export function doBuild(world, agentId) {
  const s = world.survival;
  const site = atLoc(s.sites, world.loc[agentId]);
  if (!site) return { ok: false, code: 'NO_SITE' };
  site.progress += residentStage(world, agentId) === 'elder' ? 1 : LABOR_PER_ACTION; // P1-1：老年施工减产
  if (site.progress >= BUILDINGS[site.type].labor) {
    s.sites = s.sites.filter((x) => x !== site);
    s.buildings.push({ type: site.type, loc: site.loc, at: site.at, lot:site.lot??constructionLot(site.loc,world.campLayout), integrity: 1 });
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
// ── 采集与蓄养产出（§16+，2026-11-12）────────────────────────────────────
// 规则层是唯一裁决点：合法性、冷却、上限、季节产量都在这里定，前端只读结果。
// 新资源走独立的 produce 账（berry/fruit/egg/milk/wool），不并入 store/inv，
// 因此既有生存基线 digest 的字段集合不变（这是刻意的口径约束，不是遗漏）。
export const PRODUCE_KINDS = Object.freeze(['berry', 'fruit', 'egg', 'milk', 'wool']);
export const DEFAULT_LIVESTOCK = Object.freeze({ chickens: 3, cows: 2, sheep: 2, orchards: 3 });
const SEASON_YIELD = Object.freeze({
  fruit: [2, 3, 1, 0],  // 春 夏 秋 冬：每棵果树
  egg:   [3, 3, 2, 1],  // 每只鸡
  milk:  [2, 2, 1, 1],  // 每头奶牛
  wool:  [1, 2, 2, 0],  // 每只羊
});
export const PRODUCE_CAP = 24;

export function forageRule(world, id) {
  const s = world.survival;
  if (!s) return { ok: false, code: 'NO_SURVIVAL' };
  if (!(world.outdoor ?? []).includes(world.loc?.[id])) return { ok: false, code: 'NOT_OUTDOOR' };
  if ((s.forageCd ?? 0) > world.t) return { ok: false, code: 'FORAGE_COOLDOWN' };
  if ((s.produce?.berry ?? 0) >= PRODUCE_CAP) return { ok: false, code: 'PRODUCE_FULL' };
  return { ok: true, code: 'OK' };
}

// 日界结算：季节 × 存栏数；纯函数，输出各资源增量。
export function produceYield(season, counts = DEFAULT_LIVESTOCK) {
  const out = {};
  for (const [kind, ramp] of Object.entries(SEASON_YIELD)) {
    const n = kind === 'fruit' ? counts.orchards : counts[kind === 'egg' ? 'chickens' : kind === 'milk' ? 'cows' : 'sheep'];
    out[kind] = ramp[season % 4] * (n ?? 0);
  }
  return out;
}

// ── 产出兑换 / 蓄养扩建 / 采浆果（§17，AI 与玩家同权）──────────────────
// 这三个动作与 harvest/gather 同层：规则层裁决 + actuate 执行，affordancesFor 对双方都给候选。
export const EXCHANGE = Object.freeze({
  berry: { store: 1 }, fruit: { store: 2 }, egg: { store: 1 }, milk: { store: 2 }, wool: { wood: 1 },
});
export const EXPAND = Object.freeze({
  chickens: { wood: 2, stone: 1 }, cows: { wood: 3, stone: 2 },
  sheep: { wood: 2, stone: 2 }, orchards: { wood: 3, stone: 1 },
});
export const EXPAND_LABEL = Object.freeze({ chickens: '鸡舍', cows: '牛棚', sheep: '羊圈', orchards: '果树' });
export const PRODUCE_LABEL = Object.freeze({ berry: '浆果', fruit: '果', egg: '蛋', milk: '奶', wool: '毛' });
export const LIVESTOCK_CAP = 12;
export const FORAGE_COOLDOWN = 2;

export function doForage(world, id) {
  const s = world.survival;
  if (!s) return { ok: false, code: 'NOT_AVAILABLE' };
  if (!(world.outdoor ?? []).includes(world.loc?.[id])) return { ok: false, code: 'NOT_OUTDOOR' };
  if ((s.forageCd ?? 0) > world.t) return { ok: false, code: 'FORAGE_COOLDOWN' };
  if ((s.produce?.berry ?? 0) >= PRODUCE_CAP) return { ok: false, code: 'PRODUCE_FULL' };
  s.produce ??= Object.fromEntries(PRODUCE_KINDS.map((k) => [k, 0]));
  s.produce.berry += 1;
  s.forageCd = world.t + FORAGE_COOLDOWN;
  return { ok: true, code: 'OK', amount: 1 };
}

export function doExchange(world, id, kind) {
  const s = world.survival, rate = EXCHANGE[kind];
  if (!s || !rate) return { ok: false, code: 'NO_RATE' };
  if ((s.produce?.[kind] ?? 0) < 1) return { ok: false, code: 'NO_PRODUCE' };
  // 仓容必须走 effectiveMods（谷仓 +12 才生效）；旧实现读 s.storeCap 固定 24，谷仓只改善收获上限。
  const cap = effectiveMods(world).storeCap;
  // 70% 仓容门槛：粮类兑换不能把公仓顶满，否则灾害/损耗没有作用空间（P2-4 stakes）。
  if (rate.store && s.store >= cap * .7) return { ok: false, code: 'STORE_FULL' };
  s.produce[kind] -= 1;
  let gained;
  if (rate.store) { s.store = Math.min(cap, s.store + rate.store); gained = `粮+${rate.store}`; }
  else { s.inv.wood = (s.inv.wood ?? 0) + rate.wood; gained = `木+${rate.wood}`; }
  return { ok: true, code: 'OK', gained };
}

export function doExpand(world, id, type) {
  const s = world.survival, cost = EXPAND[type];
  if (!s || !cost) return { ok: false, code: 'NO_TYPE' };
  s.livestock ??= { ...DEFAULT_LIVESTOCK };
  if ((s.livestock[type] ?? 0) >= LIVESTOCK_CAP) return { ok: false, code: 'LIVESTOCK_FULL' };
  // 与候选侧同一条裁决：材料必须富余（留一份建筑料），不能挤掉建房。
  if ((s.inv?.wood ?? 0) < cost.wood + 4 || (s.inv?.stone ?? 0) < cost.stone + 3) return { ok: false, code: 'NO_MATERIAL' };
  s.inv.wood -= cost.wood; s.inv.stone -= cost.stone;
  s.livestock[type] = (s.livestock[type] ?? 0) + 1;
  if (s.ecosystem && s.ecoPop && (type === 'chickens' || type === 'orchards')) {
    const prefix = type === 'chickens' ? 'ch' : 'or';
    s.ecoPop[type].push({ id: `${prefix}${++s.ecoSeq[prefix]}`, born: world.t, health: 1 }); // P1-5 扩建个体从幼体成长
  }
  return { ok: true, code: 'OK', label: EXPAND_LABEL[type] };
}

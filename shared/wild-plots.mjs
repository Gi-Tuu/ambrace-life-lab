// 1.2 A：荒野宅基地（聚落外环的确定性地块）。
//
// 口径：
//   · 纯数据 + 纯几何：只吃 mapSeed / layoutVersion，确定性、无 RNG、Node/浏览器同构；
//   · 未认领地块**零几何**：不写 terrain/flats/clearing/道路/房屋，金样画布与既有世界逐位不变；
//   · 认领后由 campSceneContent 把地块 pad 并进 flatLand/clearing 并画接入小路（同一份数据两端共用）；
//   · 地块记录里的 `road` 是“地块门 → 同岸村口站点”的可走路线（逐点 terrain.walkable），
//     认领后它就是画出来的那条小路；`wildHouseSolids` 是已认领地块房屋的同一份 AABB。
//
// 位置筛选（缺一不可）：聚落矩形外环 6–20 单位；不在营地内；干地（bankGap≥2.2）；
// 坡度四角高差 ≤1.1；pad 逐点可走（含树体半径）；不压地标/落石；与已选地块间隔 ≥9；
// 且存在从地块门到同岸村口站点的可走路线（通路）。
import { campHash } from './camp-terrain.mjs';
import { TOWN_SIZE, generateCampLayout } from './camp-layout.mjs';
import { CAMP_SITES } from './camp-interaction.mjs';
import { inCamp, wildLandscape } from './wild-landscape.mjs';
import { worldRoute } from './asset-collision.mjs';

export const WILD_PLOT_MAX = 8;
export const WILD_PLOT_MIN = 4;
export const WILD_PLOT_PREFIX = 'wild-';
// 荒野宅基地建房的木石成本与工时（与既有住宅开工一致；客户端 UI 只读这一份）。
export const WILD_HOUSE_COST = Object.freeze({ wood: 5, stone: 3 });
export const WILD_HOUSE_LABOR = 3;

// 住宅锚点与既有 residentialSite 同口径：lot 由 homeLot 的公式派生（camp-layout.homeLot）。
export const wildPlotLot = ([x, z]) => ({ x: x - 2.3, z: z - 6.05, w: 4.6, d: 3.7 });
export const wildPlotGate = ([x, z]) => ({ x: x - 1.15, z: z - 2.55, w: 2.3, d: 1.6 });
// pad 覆盖房屋 + 门前 + 一圈余量；认领后压平/清林，未认领时完全不参与几何。
export const wildPlotPad = ([x, z]) => ({ x: x - 3.2, z: z - 6.8, w: 6.4, d: 6.6 });

const WEST = Object.freeze(['hall', 'home', 'store', 'yard', 'garden']);
const EAST = Object.freeze(['well', 'workshop', 'watch']);
const DISTRICTS = Object.freeze({ west: WEST, east: EAST });

const padSamples = (pad, step = 1) => {
  const out = [];
  for (let z = pad.z + .4; z < pad.z + pad.d - .3; z += step) {
    for (let x = pad.x + .4; x < pad.x + pad.w - .3; x += step) out.push([x, z]);
  }
  out.push([pad.x + pad.w / 2, pad.z + pad.d / 2]);
  return out;
};
// 建房校验会问到的关键点（lot 四角/中心 + 地块门），必须和 pad 网格一起过自然可站检查。
const footprintSamples = (at) => {
  const lot = wildPlotLot(at), gate = wildPlotGate(at);
  return [[lot.x, lot.z], [lot.x + lot.w, lot.z], [lot.x, lot.z + lot.d], [lot.x + lot.w, lot.z + lot.d],
    [lot.x + lot.w / 2, lot.z + lot.d / 2], [gate.x + gate.w / 2, gate.z + gate.d / 2]];
};

function ringPoints(seed, count) {
  const cx = TOWN_SIZE.width / 2, cz = TOWN_SIZE.depth / 2;
  const hw = TOWN_SIZE.width / 2, hd = TOWN_SIZE.depth / 2;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + campHash(seed, 'wild-plot-angle') * .4;
    const dx = Math.cos(a), dz = Math.sin(a);
    const tx = Math.abs(dx) < 1e-9 ? Infinity : hw / Math.abs(dx);
    const tz = Math.abs(dz) < 1e-9 ? Infinity : hd / Math.abs(dz);
    const edge = Math.min(tx, tz);
    const depth = 6 + campHash(seed, 'wild-plot-depth:' + i) * 14;
    out.push([Math.round(cx + dx * (edge + depth)), Math.round(cz + dz * (edge + depth))]);
  }
  return out;
}

// 自然可站/可建（未认领状态）：地形干、平、无树体、无地标。
function naturalBuildable(terrain, crossing, x, z) {
  const pad = wildPlotPad([x, z]);
  for (const [px, pz] of [...padSamples(pad), ...footprintSamples([x, z])]) {
    if (inCamp(px, pz)) return false;
    if (terrain.bankGap(px, pz) < 2.2) return false;
    if (!terrain.walkable(px, pz, crossing)) return false;
  }
  const corners = [[pad.x, pad.z], [pad.x + pad.w, pad.z], [pad.x, pad.z + pad.d], [pad.x + pad.w, pad.z + pad.d]]
    .map(([px, pz]) => terrain.height(px, pz));
  if (Math.max(...corners) - Math.min(...corners) > 1.1) return false;
  return !terrain.landmarks().some((feature) => feature.cores.some((b) =>
    pad.x + pad.w > b.x - 1 && pad.x < b.x + b.w + 1 && pad.z + pad.d > b.z - 1 && pad.z < b.z + b.d + 1));
}

// 聚落矩形边界：地块接入路只画到村口/聚落外沿，村内那一段由既有村道承担。
function outsideOnly(a, b) {
  // 线段 a→b 进入营地时，返回到边界的最后一个外侧点（按 1/256 细分，确定性）。
  let last = a;
  for (let i = 1; i <= 256; i += 1) {
    const t = i / 256;
    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (inCamp(point[0], point[1])) return last;
    last = point;
  }
  return b;
}

// 接入路线：地块门 → 同岸最近的村口站点；返回可走的折线（认领后照此画路）。
function accessRoad(terrain, crossing, sites, at) {
  const gate = wildPlotGate(at);
  const from = [gate.x + gate.w / 2, gate.z + gate.d / 2];
  const side = at[0] < terrain.river(at[1]) ? 'west' : 'east';
  const anchors = DISTRICTS[side]
    .filter((key) => Array.isArray(sites[key]))
    .map((key) => [key, sites[key]])
    .sort((a, b) => Math.hypot(a[1][0] - at[0], a[1][1] - at[1]) - Math.hypot(b[1][0] - at[0], b[1][1] - at[1]));
  const allows = (x, z) => terrain.walkable(x, z, crossing);
  if (!allows(...from)) return null;
  for (const [site, anchor] of anchors.slice(0, 3)) {
    const route = worldRoute(from, [anchor[0] + .5, anchor[1] + .5], allows, { margins: [14, 60, 135] });
    if (!route) continue;
    const road = [[from[0], from[1]]];
    let reached = false;
    for (const point of route) {
      const last = road.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < .5) continue;
      if (inCamp(point[0], point[1])) {
        const edge = outsideOnly(last, point);
        if (Math.hypot(edge[0] - last[0], edge[1] - last[1]) > .5) road.push([edge[0], edge[1]]);
        reached = true;
        break;
      }
      road.push([point[0], point[1]]);
    }
    if (road.length > 64) continue;
    if (!road.every(([x, z]) => !inCamp(x, z) && allows(x, z))) continue;
    return { road, site, reached };
  }
  return null;
}

/**
 * 确定性生成荒野宅基地（4–8 个）。
 * @returns {{plots:Array<{id:string,at:[number,number],lot:object,gate:object,pad:object,road:Array<[number,number]>,roadSite:string}>}}
 */
export function generateWildPlots(mapSeed = 0, layoutVersion = 2) {
  // layout 0（内置种子存档/旧世界）没有 campLayout：村口锚点与河桥用共享硬编码表，与 content 同源。
  const layout = layoutVersion >= 2 ? generateCampLayout(mapSeed, layoutVersion) : null;
  const sites = layout?.sites ?? CAMP_SITES;
  const terrain = wildLandscape(mapSeed, layoutVersion, { joined: true });
  const crossing = layout?.crossZ ?? 34;
  const accepted = [];
  const seen = new Set();
  const consider = (x, z) => {
    const key = x + ',' + z;
    if (seen.has(key)) return;
    seen.add(key);
    if (accepted.length >= WILD_PLOT_MAX) return;
    if (accepted.some(([ax, az]) => Math.hypot(ax - x, az - z) < 9)) return;
    if (!naturalBuildable(terrain, crossing, x, z)) return;
    accepted.push([x, z]);
  };
  for (const count of [96, 192]) {
    for (const [x, z] of ringPoints(mapSeed, count)) consider(x, z);
    if (accepted.length >= WILD_PLOT_MIN) break;
  }
  // 兜底：外环网格（确定性顺序），只在环带内、按种子排序，保证任何种子都能凑够下限。
  if (accepted.length < WILD_PLOT_MIN) {
    const band = [];
    for (let x = -22; x <= TOWN_SIZE.width + 22; x += 2) {
      for (let z = -22; z <= TOWN_SIZE.depth + 22; z += 2) {
        if (inCamp(x, z)) continue;
        const out = x < 0 || x >= TOWN_SIZE.width || z < 0 || z >= TOWN_SIZE.depth;
        if (!out) continue;
        const gap = Math.max(0, -x, x - TOWN_SIZE.width, -z, z - TOWN_SIZE.depth);
        if (gap < 6 || gap > 20) continue;
        band.push([x, z, campHash(mapSeed, 'wild-scan:' + x + ':' + z)]);
      }
    }
    band.sort((a, b) => a[2] - b[2]);
    for (const [x, z] of band) consider(x, z);
  }
  const plots = [];
  for (const at of accepted) {
    const access = accessRoad(terrain, crossing, sites, at);
    if (!access) continue; // 通路筛选：没有可走接入路线的点不做宅基地
    const id = WILD_PLOT_PREFIX + (plots.length + 1);
    plots.push(Object.freeze({
      id, at: Object.freeze([at[0], at[1]]),
      lot: Object.freeze(wildPlotLot(at)),
      gate: Object.freeze(wildPlotGate(at)),
      pad: Object.freeze(wildPlotPad(at)),
      road: Object.freeze(access.road.map(([x, z]) => Object.freeze([x, z]))),
      roadSite: access.site,
    }));
  }
  return { plots: Object.freeze(plots) };
}

export const wildExpansionEnabled = (w) => Boolean(w?.survival?.wildExpansion?.enabled);
export const wildPlotsOf = (w) => w?.survival?.wildExpansion?.plots ?? [];
export const wildClaimsOf = (w) => w?.survival?.wildExpansion?.claims ?? {};
export const wildPlotById = (w, id) => wildPlotsOf(w).find((plot) => plot.id === id) ?? null;
export const wildPlotClaim = (w, id) => wildClaimsOf(w)[id] ?? null;
export const wildPlotClaimed = (w, id) => Boolean(wildPlotClaim(w, id));

// 已认领但尚未有房屋的地块：认领即占位（同一地块不会两人同抢）。
export function wildPlotOwned(w, id) {
  const claim = wildPlotClaim(w, id);
  if (claim) return claim;
  const home = w?.peripheralHomes?.[id];
  const deed = w?.survival?.households?.deeds?.[id];
  const project = w?.survival?.households?.projects?.[id];
  if (Array.isArray(home) && !deed && !project) return { plot: id, at: [home[0], home[1]], by: null, t: null };
  if (deed || project) {
    const at = w?.peripheralHomes?.[id] ?? wildPlotById(w, id)?.at ?? null;
    if (at) return { plot: id, at: [at[0], at[1]], by: deed?.owner ?? project?.owner ?? null, t: project?.started ?? null };
  }
  return null;
}

export function wildPlotCandidates(w) {
  return wildPlotsOf(w).filter((plot) => !wildPlotOwned(w, plot.id));
}

/**
 * 认领写入（唯一入口）：原子地写 claims + peripheralHomes + locs 标签。
 * 调用方必须先完成距离/材料/可站/可达校验，本函数只做一次同步写入。
 */
export function registerWildClaim(w, id, plot, by, t = w?.t ?? 0) {
  const s = w.survival;
  (s.wildExpansion ??= { enabled: true, plots: wildPlotsOf(w), claims: {} });
  (s.wildExpansion.claims ??= {})[id] = { at: [plot.at[0], plot.at[1]], by, t };
  (w.peripheralHomes ??= {})[id] = [plot.at[0], plot.at[1]];
  if (w.locs && !Object.hasOwn(w.locs, id)) w.locs[id] = '住宅工地';
  return s.wildExpansion.claims[id];
}

/** 读档/建房后的自愈：把 claims 合并回 peripheralHomes（旧档没有字段时是空操作）。 */
export function restoreWildExpansion(w) {
  if (!wildExpansionEnabled(w)) return;
  w.peripheralHomes ??= {};
  for (const [id, claim] of Object.entries(wildClaimsOf(w))) {
    if (Array.isArray(claim?.at)) w.peripheralHomes[id] = [claim.at[0], claim.at[1]];
  }
}

/**
 * 正式游戏开局：生成荒野宅基地候选（未认领=零几何）。
 * 门控与 survplay 的既有开关一致：gameRules + 聚落/居民决策；layout 0（内置种子档）与 2 都支持。
 */
export function initWildExpansion(world, { mapSeed = 0, layoutVersion = 0, gameRules = false, settlementLife = false, residentialDecisions = false } = {}) {
  if (!(gameRules && settlementLife && residentialDecisions && world?.survival)) return null;
  const { plots } = generateWildPlots(mapSeed, layoutVersion);
  world.survival.wildExpansion = { enabled: true, plots, claims: {} };
  world.peripheralHomes ??= {};
  restoreWildExpansion(world);
  return world.survival.wildExpansion;
}

/** 客户端载荷：地块列表 + 认领态（路只给已认领的，未认领零几何）。 */
export function wildPlotView(w) {
  if (!wildExpansionEnabled(w)) return null;
  const claims = wildClaimsOf(w);
  return {
    enabled: true,
    build: { ...WILD_HOUSE_COST, labor: WILD_HOUSE_LABOR },
    plots: wildPlotsOf(w).map((plot) => {
      const claim = claims[plot.id] ?? null;
      return {
        id: plot.id, at: [plot.at[0], plot.at[1]], lot: { ...plot.lot }, gate: { ...plot.gate },
        claimed: Boolean(claim), owner: claim?.by ?? null, at_t: claim?.t ?? null,
        ...(claim ? { road: plot.road.map(([x, z]) => [x, z]), roadSite: plot.roadSite } : {}),
      };
    }),
  };
}

/** 认领态签名：client buildWorld / server sceneGeometry / sceneSpace 缓存失效用。
 *  同时接受服务端 world（survival.wildExpansion）与客户端视图（wildPlots.plots[].claimed）。 */
export function wildClaimSignature(source) {
  const claims = source?.survival ? wildClaimsOf(source) : null;
  const entries = claims
    ? Object.entries(claims).map(([id, claim]) => [id, claim?.at ?? null])
    : (source?.wildPlots?.plots ?? []).filter((plot) => plot.claimed).map((plot) => [plot.id, plot.at ?? null]);
  return JSON.stringify(entries.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** 已认领地块的房屋 AABB：client buildWorld 与 server sceneSpace 用同一份。 */
export function wildHouseSolids(source) {
  const claims = source?.survival ? wildClaimsOf(source) : null;
  const entries = claims
    ? Object.entries(claims).map(([id, claim]) => [id, claim?.at ?? null])
    : (source?.wildPlots?.plots ?? []).filter((plot) => plot.claimed).map((plot) => [plot.id, plot.at ?? null]);
  return entries.map(([, at]) => {
    if (!Array.isArray(at)) return null;
    const lot = wildPlotLot(at);
    return { x: lot.x, z: lot.z, w: lot.w, d: lot.d, solid: true, kind: 'wild-house' };
  }).filter(Boolean);
}

/** 地块中心/门的世界点（服务端校验与客户端交互共用）。 */
export const wildPlotCenter = (plot) => [plot.at[0], plot.at[1]];
export const wildPlotDoor = (plot) => [plot.gate.x + plot.gate.w / 2, plot.gate.z + plot.gate.d / 2];

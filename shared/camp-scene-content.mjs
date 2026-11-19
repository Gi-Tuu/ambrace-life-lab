// P2b：营地场景内容的唯一来源（纯模块，Node / 浏览器同构）。
//
// 背景：树/岩/山丘浮雕此前只存在于 web/app.js 的 buildWorld() 返回值里，服务端
// construction-access 只能传 trees:[]、不带 hills，导致 P2 一致性抽样 walk 480/441、
// height 47 点差异。这里把那段**确定性生成**原样抽出来：
//   · 输入只来自 survView（mapSeed/layoutVersion/layout/rooms/districts/peripheralHomes/
//     households/homeRoads/ecoSources）或服务端等价字段；
//   · 使用共享纯函数 campTerrain/campBeds/penLayout/campPlants/createCampOutskirts/
//     forestDensity/reliefAt/hash2，没有 Math.random、没有 DOM/ASSETS；
//   · 输出 trees/rocks/hills/bridges 直接喂 outdoorStage，客户端与服务端因此拿到同一份。
//
// 约束：本模块的顺序、阈值、取整必须与 web/app.js 抽出的原实现逐位相同——golden 的
// trees/bridges/scene3d hash 是这条约束的闸门。任何“顺手优化”都会让它变红。
import { campTerrain, reliefAt, hash2 } from './camp-terrain.mjs';
import { campBridgeBounds, constructionLot, overlapsLot, residentialSite, HOUSING_PLOTS, TIMBER_GROVE, TOWN_SIZE } from './camp-layout.mjs';
import { campBeds, CAMP_SITES, campPlants } from './camp-interaction.mjs';
import { districtPads } from './camp-districts.mjs';
import { createCampOutskirts } from './camp-outskirts.mjs';
import { forestDensity } from './wild-landscape.mjs';
import { penLayout } from './camp-scene.mjs';

export const TILE = 16;
export const WORLD_TW = TOWN_SIZE.width;
export const WORLD_TH = TOWN_SIZE.depth;
export const WORLD_W = WORLD_TW * TILE;
export const WORLD_H = WORLD_TH * TILE;

// 地点表兜底（w.rooms 缺键时按顺序取）；与 web/app.js 原 sitesOf 的 SITE_FALLBACK 一致。
export const SITE_FALLBACK = [[22, 20], [34, 16], [52, 20], [64, 30], [26, 42], [46, 44], [70, 10], [56, 38]];
export const ROAD_LINKS = [
  ['home','hall',[]],['hall','store',[]],['home','yard',[[22,28],[20,31]]],
  ['yard','garden',[[23,37]]],['hall','crossing',[[33,28],[37,32]]],
  ['garden','crossing',[[36,39],[38,37]]],['crossing','well',[]],
  ['well','workshop',[[55,35],[59,33]]],['workshop','watch',[[67,29],[71,23],[72,17],[70,14]]],
];

export const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
export const tileKey = (x, y) => `${x},${y}`;
const insideBed = (x, y, b, pad = 0) => x >= b.x - pad && x < b.x + b.w + pad && y >= b.y - pad && y < b.y + b.h + pad;

// 地点表：与 web/app.js 原 sitesOf 同一公式（districts > layout > 硬编码 > 住宅 > 兜底）。
// rooms 缺省时按 client 视角的 locs 表处理；服务端传 w.locs 即可。
export function campSitesOf({ rooms = null, districts = null, layout = null, peripheralHomes = null } = {}) {
  const keys = Object.keys(rooms ?? CAMP_SITES);
  const out = {};
  keys.forEach((r, i) => {
    out[r] = districts?.[r]?.at ?? layout?.sites[r] ?? CAMP_SITES[r] ??
      residentialSite(r, peripheralHomes) ?? SITE_FALLBACK[i % SITE_FALLBACK.length];
  });
  return out;
}

// stage 只画“非区域/非住宅”的固定地点；districts 与 residentialSite 命中项由 homes3d/区域层负责。
export function staticCampSites(sites, districts = null, peripheralHomes = null) {
  return Object.fromEntries(Object.entries(sites)
    .filter(([room]) => !districts?.[room] && !residentialSite(room, peripheralHomes)));
}

/**
 * 生成营地场景内容。返回值可直接拆给 outdoorStage：
 *   { trees, rocks, hills, bridges, bridgeCells, landscape, blockers, ... }
 * 其余字段（helpers/地形函数/保留地）供客户端维持原渲染与 walk 栅格，服务端只用几何。
 *
 * @param {object} spec
 * @param {number} spec.mapSeed
 * @param {number} spec.layoutVersion
 * @param {object|null} spec.layout
 * @param {object|boolean} spec.camp       view.camp（对象）或 true
 * @param {boolean} [spec.timber]          w.camp?.timber 的布尔值（决定树林空地避让）
 * @param {object} spec.sites              staticCampSites() 结果
 * @param {object|null} [spec.districts]
 * @param {object|null} [spec.peripheralHomes]
 * @param {object} [spec.households]      view.households / survival.households（含 deeds）
 * @param {object} [spec.homeRoads]
 * @param {object} [spec.ecoSources]
 */
export function campSceneContent({
  mapSeed = 0, layoutVersion = 0, layout = null, camp = false, timber = false,
  sites = {}, districts = null, peripheralHomes = null, households = false,
  homeRoads = {}, ecoSources = null,
} = {}) {
  const campOn = Boolean(camp);
  const hasTimber = Boolean(timber);
  const hasHouseholds = Boolean(households);
  const { river, riverCenter: streamCenter, riverHalfWidth: streamHalfWidth, hills: candidates } =
    campTerrain(mapSeed, campOn, layoutVersion);
  const grove = layout?.grove ?? TIMBER_GROVE;
  const terrainHash = mapSeed ? (x, z, s) => hash2(x, z, s + mapSeed) : hash2;
  const blockers = new Set();
  const occupy = (x, y) => { blockers.add(tileKey(x, y)); };

  const bridges = [], rocks = [];
  const trees = [];

  // 缓弯土路：共享入口与桥位，曲线只用于烘焙，不改变引擎地点关系。
  const roads = [], bins = new Map(), binSize = 64;
  const addSegment = (a, b, hidden) => {
    const r = [...a, ...b, hidden]; roads.push(r);
    for (let y = Math.floor((Math.min(a[1], b[1]) - 40) / binSize); y <= Math.floor((Math.max(a[1], b[1]) + 40) / binSize); y++)
      for (let x = Math.floor((Math.min(a[0], b[0]) - 40) / binSize); x <= Math.floor((Math.max(a[0], b[0]) + 40) / binSize); x++) {
        const key = tileKey(x, y); if (!bins.has(key)) bins.set(key, []); bins.get(key).push(r);
      }
  };
  const routeSites = layout ? { ...layout.sites, ...layout.nodes } : { ...sites };
  const links = layout ? [...layout.links] : [...ROAD_LINKS];
  if (!layout) {
    if (sites.well) routeSites.crossing = [Math.round(river(34)) - 4, 34];
    const homes = hasHouseholds ? Object.keys(HOUSING_PLOTS) : Object.keys(sites).filter((r) => residentialSite(r, peripheralHomes));
    if (homes.length) {
      Object.assign(routeSites, { residential: [75, 38], northLane: [89, 43], southLane: [89, 56], edgeLane: [89, 69] });
      links.push(['workshop', 'residential', [[68, 33]]], ['residential', 'northLane', [[79, 40]]], ['northLane', 'southLane', []]);
      if (hasHouseholds) links.push(['southLane', 'edgeLane', []]);
      for (const room of homes) {
        routeSites[room] = residentialSite(room, peripheralHomes);
        const z = routeSites[room][1];
        links.push([z < 50 ? 'northLane' : z < 62 ? 'southLane' : 'edgeLane', room, []]);
      }
    }
    if (hasTimber && sites.yard) {
      routeSites.grove = [15, 42];
      links.push(['yard', 'grove', [[19, 37], [17, 40]]]);
    }
    if (!sites.well && sites.store && sites.watch) {
      routeSites.crossing = [Math.round(river(34)) - 4, 34];
      links.push(['store', 'crossing', [[38, 28]]], ['crossing', 'watch', [[49, 34], [61, 32], [71, 23], [72, 17], [70, 14]]]);
    }
  }
  for (const [loc, district] of Object.entries(districts ?? {})) {
    const home = 'house-' + loc;
    if (!district.home || !households?.deeds?.[home] || !homeRoads?.[home]?.present) continue;
    const [x, z] = district.home;
    const [sx, sz] = district.at;
    addSegment([(x + .5) * TILE, (z - 1.1) * TILE], [(x + .5) * TILE, (sz + 2.6) * TILE]);
    addSegment([(x + .5) * TILE, (sz + 2.6) * TILE], [(sx + .5) * TILE, (sz + 2.6) * TILE]);
  }
  for (const [u, v, mids] of links) {
    if (!routeSites[u] || !routeSites[v]) continue;
    const points = [routeSites[u], ...mids, routeSites[v]].map((p) => p.map((n) => n * TILE + 8));
    for (let j = 0; j < points.length - 1; j++) {
      const p0 = points[Math.max(0, j - 1)], p1 = points[j], p2 = points[j + 1], p3 = points[Math.min(points.length - 1, j + 2)];
      const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 8)); let prev = p1;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const pt = [0, 1].map((axis) => {
          const z0 = p0[axis], z1 = p1[axis], z2 = p2[axis], z3 = p3[axis];
          return 0.5 * (2 * z1 + (-z0 + z2) * t + (2 * z0 - 5 * z1 + 4 * z2 - z3) * t * t + (-z0 + 3 * z1 - 3 * z2 + z3) * t * t * t);
        });
        addSegment(prev, pt, homeRoads?.[v]?.present === false); prev = pt;
      }
    }
  }
  const roadDist = (px, py, paint = false) => (bins.get(tileKey(Math.floor(px / binSize), Math.floor(py / binSize))) ?? [])
    .reduce((d, r) => paint && r[4] ? d : Math.min(d, distSeg(px, py, r[0], r[1], r[2], r[3])), 80);
  const onRoad = (tx, ty) => roadDist(tx * TILE + 8, ty * TILE + 8) < 23;
  const nearSite = (tx, ty, pad = 2) => Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < pad && Math.abs(ty - sy) < pad);
  const onRiver = (tx, ty) => Math.abs(tx * TILE + 8 - streamCenter(ty * TILE + 8)) < 34;

  // 1–3) 菜园/圈舍/保留地：同一份几何同时决定地形分类与植被避让。
  // beds 保留为空数组：原实现把它传给 terrainKinds，但实际苗床来自 land；逐位保持语义。
  const beds = [];
  const land = campBeds(sites.garden, mapSeed, layoutVersion);
  const pen = penLayout(sites);
  const onFarm = (x, z, pad = 0) => land.some((b) => x >= b.x - pad && x < b.x + b.w + pad && z >= b.z - pad && z < b.z + b.d + pad);
  const inPen = (tx, tz) => pen && tx + .5 >= pen.x - 1 && tx + .5 <= pen.x + pen.w + 1 &&
    tz + .5 >= pen.z - 1 && tz + .5 <= pen.z + pen.d + 1;
  const reserved = Object.keys(sites).map((room) => constructionLot(room, layout)).filter(Boolean);
  if (households) for (const [x, z] of Object.keys(HOUSING_PLOTS).map((room) => layout?.sites[room] ?? HOUSING_PLOTS[room])) {
    reserved.push({ x: x - 3.15, z: z - 6.5, w: 6.3, d: 6.8 });
  }
  const pads = districtPads(districts);
  const flatLand = [
    ...reserved, ...pads,
    ...Object.values(sites).map(([x, z]) => ({ x: x - 4.5, z: z - 8, w: 9, d: 11 })),
    ...land,
    ...grove.map(({ x, z }) => ({ x: x - 1, z: z - 1, w: 2, d: 2 })),
    ...(pen ? [pen] : []),
  ];
  const hills = candidates.filter((hill) => {
    const { x, z, rx, rz } = hill;
    const footprint = { x: x - rx - 1, z: z - rz, w: 2 * rx + 2, d: 2 * rz };
    return !flatLand.some((lot) => overlapsLot(footprint, lot)) &&
      Array.from({ length: 2 * rz + 1 }, (_, i) => z - rz + i).every((y) => Math.abs(x - river(y)) > rx + 3.5);
  });

  const roadDistance = (x, z) => roadDist(x * TILE, z * TILE, true) / TILE;
  const highGround = (x, z) => hills.some((hill) => reliefAt(hill, x + .5, z + .5) > .055);
  const nearLot = (x, z, pad = .85) => reserved.some((lot) => overlapsLot({ x, z, w: 1, d: 1 }, lot, pad));
  const nearGrove = (x, z) => hasTimber && grove.some((t) => Math.hypot(x + .5 - t.x, z + .5 - t.z) < 1.7);
  const plantClearance = (x, z) => {
    const tx = Math.floor(x), tz = Math.floor(z);
    return !inPen(tx, tz) && !nearLot(tx, tz, 0) && !nearGrove(tx, tz) && !onFarm(x, z, .8) &&
      !nearSite(x, z, 2.5) && roadDistance(x, z) > 1.3 &&
      !blockers.has(tileKey(tx, tz)) && !flatLand.some((lot) =>
        x >= lot.x && x < lot.x + lot.w && z >= lot.z && z < lot.z + lot.d);
  };
  const harvestNodes = campOn ? campPlants(layout, 12, mapSeed, layoutVersion, ecoSources ?
    { ...ecoSources, fruit: Array.from({ length: 12 }, (_, slot) => ({ id: `fruit:${slot}`, slot })) } : undefined) : [];
  const landscape = campOn ? createCampOutskirts(mapSeed, layoutVersion ?? 0, layout?.crossZ ?? 34,
    { flatLand, hills, roadDistance, plantClearance, harvestNodes, districtPads: pads }) : null;

  // 一次跨河对应一座完整木桥；同一组 bridgeCells 同时决定绘制与可走范围。
  const bridgeCells = new Set(), bridgeRows = [];
  if (layout) bridgeRows.push(layout.crossZ);
  else for (let ty = 1; ty < WORLD_TH - 1; ty++) if (roadDist(river(ty + .5) * TILE, ty * TILE + 8) < 14) bridgeRows.push(ty);
  const groups = [];
  for (const row of bridgeRows) {
    const first = Math.max(0, row - 1), last = Math.min(WORLD_TH - 1, row + 1), prior = groups.at(-1);
    if (prior && first <= prior[1] + 1) prior[1] = Math.max(prior[1], last);
    else groups.push([first, last]);
  }
  for (const [first, last] of groups) {
    // 两侧坡道均伸过河岸，留出角色和推车的上桥余量。
    const bounds = campBridgeBounds(first, last, streamCenter, streamHalfWidth);
    const [x0, y0, x1, y1] = bounds.map((v) => v * TILE);
    bridges.push(bounds);
    for (let ty = first; ty <= last; ty++) for (let tx = x0 / TILE; tx < x1 / TILE; tx++) bridgeCells.add(tileKey(tx, ty));
  }

  const watch = sites.watch ?? CAMP_SITES.watch;
  for (let ty = watch[1] - 6; ty <= watch[1] + 6; ty += 1) for (let tx = watch[0] - 8; tx <= watch[0] + 8; tx += 1) {
    if (highGround(tx, ty) || onRoad(tx, ty) || nearLot(tx, ty)) continue;
    const d = Math.hypot((tx - watch[0]) / 7, (ty - watch[1]) / 5);
    if (d > 1.25 || (d <= 1 && terrainHash(tx, ty, 3) > 0.82)) continue;
    if (d > 1) continue;
    rocks.push([tx, ty]);
    occupy(tx, ty);
  }

  const byBridge = (x, z) => bridges.some(([x0, z0, x1, z1]) => x >= x0 - 1 && x <= x1 && z >= z0 - 1 && z <= z1);
  // 5) 树林：边缘密、村落内部疏；避开道路、河、田、岩与屋舍。树冠双 tone + 树干。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    if (highGround(tx, ty) || onRoad(tx, ty) || onRiver(tx, ty) || byBridge(tx, ty) || inPen(tx, ty) || nearLot(tx, ty) || nearGrove(tx, ty) || blockers.has(tileKey(tx, ty))) continue;
    const edge = Math.min(tx, WORLD_TW - 1 - tx, ty, WORLD_TH - 1 - ty);
    const density = landscape ? forestDensity(mapSeed, tx + .5, ty + .5) * .76 :
      edge < 6 ? 0.20 : edge < 14 ? 0.10 : 0.038;
    if (trees.some(([x, y]) => Math.hypot(x - tx, (y - ty) * 1.25) < 2.8) || beds.some((b) => insideBed(tx * TILE + 8, ty * TILE + 8, b, 28))) continue;
    if (terrainHash(tx, ty, 4) > density || nearSite(tx, ty, 4) || onFarm(tx + .5, ty + .5, 2) || Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < 5 && ty > sy - 10 && ty < sy + 1)) continue;
    occupy(tx, ty);
    trees.push([tx, ty]);
  }

  return {
    sites, grove, trees, rocks, hills, bridges, bridgeCells, landscape,
    blockers, roads, reserved, pads, land, pen, flatLand, beds,
    roadDist, roadDistance, plantClearance, harvestNodes, terrainHash,
    river, streamCenter, streamHalfWidth,
    helpers: { onRoad, onRiver, byBridge, nearSite, nearLot, nearGrove, onFarm, inPen, highGround, terrainHash },
  };
}

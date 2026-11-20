import { campEntrance, campSite } from '../shared/camp-interaction.mjs';
import { overlapsLot, HOUSING_PLOTS, residentialSite } from '../shared/camp-layout.mjs';
import { roomStage, homeStyle, timberStage } from '../shared/camp-scene.mjs';
import { facilityGate, facilityOf } from '../shared/camp-facility.mjs';
import { hallFrontGeometry, roomPropsPx, ROOM_DOOR_WORLD } from '../shared/room-layout.mjs';
import { recordSettlementEvent } from './settlement-events.mjs';
import { joinedRoute } from '../shared/camp-outskirts.mjs';
import { constructionFootprint, constructionGate, entrancePoints, workPoints, clearOfLots, CONSTRUCTION_CODES } from '../shared/camp-construction-access.mjs';
import { campSurface, createSpace, roomSurface, wildSurface } from './space.mjs';
import { campSceneBundle, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';

const cache = new WeakMap();
const ok = { ok:true, code:'OK' };
const fail = (code, guide) => ({ ok:false, code, ...guide });

export const constructionAccessEnabled = w => w.gameRules === true && w.layoutVersion >= 2 && Boolean(w.campLayout);

export function siteRecord(w, loc, type, lot = constructionFootprint(loc,w.campLayout,w.districts,w.peripheralHomes,type)) {
  return {loc,type,lot};
}

const sceneCache = new WeakMap();
// P2b/P4：服务端 stage 与客户端 buildWorld 用同一份内容生成器（campSceneBundle：同一输入→同一 stage）。
// 无 campLayout 的旧世界（layout 0）也走这里，供空间一致性闸门与只读查询使用；
// 施工可达性仍只对 constructionAccessEnabled 生效。
function sceneGeometry(w) {
  const layout = w.campLayout ?? null;
  let g = sceneCache.get(w);
  if (g && g.layout === layout && g.districts === w.districts) return g;
  const landmarks = Object.fromEntries(['home','hall','store','yard','workshop','garden','watch','well']
    .map(loc => [loc,campSite(loc,layout)]));
  const liveSites = campSitesOf({ rooms:w.locs, districts:w.districts, layout, peripheralHomes:w.peripheralHomes });
  const sites = staticCampSites(liveSites, w.districts, w.peripheralHomes);
  const { content, stage } = campSceneBundle({
    mapSeed:w.mapSeed, layoutVersion:w.layoutVersion??0, layout,
    camp:true, timber:true, sites,
    districts:w.districts, peripheralHomes:w.peripheralHomes,
    households:w.survival?.households, homeRoads:w.survival?.homeRoads,
  });
  g = { layout, districts:w.districts, landmarks, sites, content, stage };
  sceneCache.set(w,g);
  return g;
}

// 只读空间查询（含无 campLayout 的世界）：与客户端 world.space 同一份 stage + 同一条地形高度链。
// 按世界缓存：playerReach 每次上报都会问它，不能每次重建 wildLandscape。
const spaceCache = new WeakMap();
export function sceneSpace(w) {
  if (!w?.survival) return null;
  const hit = spaceCache.get(w);
  const layout = w.campLayout ?? null;
  if (hit && hit.layout === layout && hit.districts === w.districts) return hit.space;
  const g = sceneGeometry(w);
  // 地形链只有一条：营地内与野外都由 campSceneContent 生成的同一份 content.landscape 回答。
  const terrain = g.content.landscape;
  const space = createSpace({
    camp: campSurface({ mapSeed:w.mapSeed, layoutVersion:w.layoutVersion??0, layout, stage:g.stage, terrain }),
    wild: wildSurface(terrain, { crossing:layout?.crossZ ?? 24 }),
    terrain,
  });
  spaceCache.set(w, { layout, districts: w.districts, space });
  return space;
}

function mapFor(w) {
  const layout = w.campLayout;
  const s = w.survival;
  let map = cache.get(w);
  if (!map || map.layout !== layout || map.districts !== w.districts) {
    const g = sceneGeometry(w);
    const { landmarks, stage } = g;
    map = { layout,districts:w.districts,anchor:[landmarks.hall[0]+.5,landmarks.hall[1]+2.7],
      fixed:stage.boxes.filter(b=>b.solid), entries:Object.values(stage.entrances), results:new Map() };
    cache.set(w,map);
  }
  const houseRooms = [...new Set([...Object.keys(s.households?.deeds??{}),...Object.keys(s.households?.projects??{})])];
  const records = [...s.sites,...s.buildings,...houseRooms.map(loc=>siteRecord(w,loc,'house'))]
    .map(b=>siteRecord(w,b.loc,b.type,b.lot)).filter(b=>b.lot);
  const regrowth = s.campTrees ?? {};
  const signature = JSON.stringify([records,layout.grove.map(tree=>(regrowth[tree.id]??0)>w.t)]);
  if (map.signature !== signature) {
    map.signature = signature;
    map.records = records;
    const timber = Object.fromEntries(layout.grove.map(tree=>[tree.id,{stage:(regrowth[tree.id]??0)>w.t?'sapling':'mature'}]));
    map.solids = [...map.fixed,...timberStage(timber,layout.grove).boxes.filter(b=>b.solid)];
    map.results.clear();
  }
  return map;
}

// P4：地面谓词只有 space 一处。旧的“解析河 + 村外 wildLandscape”双谓词回退已退役
// （只在 life/research-space.mjs 作为研究夹具保留），正式路径没有运行时开关。
export function constructionSpace(w) {
  return constructionAccessEnabled(w) ? sceneSpace(w) : null;
}
function groundQuery(w) {
  const space = constructionSpace(w);
  return (x, z) => Boolean(space) && space.walkable(x, z, 0);
}

// P2c：房间是显式 16×12 世界空间；服务端与客户端用同一份 roomStage/家具规格。
// 只统计 solid 盒子（含 hall 栏杆），门是 room-layout 的唯一 portal 数据。
const roomSpaceCache = new WeakMap();
export function roomSpaceOf(w, room) {
  if (!w?.survival || typeof room !== 'string' || !room) return null;
  let cache = roomSpaceCache.get(w);
  if (!cache) { cache = new Map(); roomSpaceCache.set(w, cache); }
  const key = [room, w.mapSeed ?? 0, w.layoutVersion ?? 0, w.campLayout ? 1 : 0, w.peripheralHomes?.[room] ? 1 : 0].join('|');
  if (cache.has(key)) return cache.get(key);
  const facility = facilityOf(w, room);
  const facilityType = facility?.type ?? (room.startsWith('facility:') ? room.split(':')[2] : null);
  const personal = Boolean(w.peripheralHomes?.[room]) || Object.hasOwn(HOUSING_PLOTS, room);
  const props = roomPropsPx(room, { personal, facility: facilityType });
  const style = residentialSite(room, w.peripheralHomes) ? homeStyle(room, w.mapSeed ?? 0) : null;
  const front = hallFrontGeometry();
  const stage = roomStage(room, props, front, 16, 12, style);
  const extras = room === 'hall'
    ? front.rails.map(([x, z, width, height]) => ({ x: x / 16, z: z / 16, w: width / 16, d: height / 16 }))
    : [];
  const space = roomSurface({ room, stage, bounds: stage.walkBounds, door: ROOM_DOOR_WORLD, extraSolids: extras });
  cache.set(key, space);
  return space;
}

// 房间在世界里的落点：室内坐标 → 世界坐标不作为几何事实（房间是独立空间），
// 但"从哪扇门出去/进来"必须唯一：用服务端的 campEntrance 门矩形中心（与客户端同一条 campEntrance）。
export function roomDoorPoint(w, room) {
  if (typeof room === 'string' && room.startsWith('facility:')) {
    const building = facilityOf(w, room);
    const gate = building && facilityGate(building, w.campLayout);
    if (gate) return [gate.x + gate.w / 2, gate.z + gate.d * .82];
  }
  const at = worldSiteOf(w, room);
  const gate = at ? campEntrance(room, at, w.peripheralHomes) : null;
  if (!gate) return null;
  return [gate.x + gate.w / 2, gate.z + gate.d / 2];
}
function worldSiteOf(w, room) {
  return w.districts?.[room]?.at ?? w.peripheralHomes?.[room] ?? campSite(room, w.campLayout);
}

export function constructionAccess(w, record, { proposed = false, from, entrance = false } = {}) {
  if (!constructionAccessEnabled(w)) return ok;
  if (!record.lot) return fail('NO_LOT');
  const map = mapFor(w);
  const others = map.records.filter(b=>b.loc!==record.loc || b.type!==record.type);
  const fixed = map.solids;
  const occupied = others.map(b=>b.lot);
  const ground = groundQuery(w);
  const clearOutside = (x,z) => ground(x,z) && clearOfLots(fixed,x,z) && clearOfLots(occupied,x,z);
  const allows = (x,z) => clearOutside(x,z) && clearOfLots([record.lot],x,z);
  const key = JSON.stringify([record,proposed]);
  let result = map.results.get(key);
  if (!result) {
    const {x,z,w:width,d} = record.lot;
    const footprint = [[x,z],[x+width,z],[x,z+d],[x+width,z+d],[x+width/2,z+d/2]];
    const gate = constructionGate(record,w.campLayout,w.peripheralHomes);
    const entryCandidates = gate ? entrancePoints(gate) : [];
    const workCandidates = workPoints(record.lot);
    const entries = entryCandidates.filter(p=>allows(...p));
    const work = workCandidates.filter(p=>allows(...p));
    const connected = points => points.find(p=>joinedRoute(p,map.anchor,allows));
    const overlap = proposed && others.find(b=>overlapsLot(record.lot,b.lot,.35));
    const badGround = proposed && footprint.find(p=>!ground(...p));
    const coveredGate = proposed && !overlap && !badGround && [...map.entries,...others.map(other=>constructionGate(other,w.campLayout,w.peripheralHomes))]
      .filter(otherGate=>otherGate && overlapsLot(otherGate,record.lot,.33))
      .map(otherGate=>entrancePoints(otherGate).filter(p=>clearOutside(...p)))
      .find(before=>before.length && !before.some(p=>allows(...p)));
    if (overlap) {
      const other=overlap.lot;
      const blockedAt=[x+Math.max(0,Math.min(width,other.x+other.w*.5-x)),
        z+Math.max(0,Math.min(d,other.z+other.d*.5-z))];
      result = fail('OCCUPIED',{blockedAt});
    } else if (badGround) result = fail('BUILD_PATH_BLOCKED',{blockedAt:badGround});
    else if (coveredGate) result = fail('BUILD_ENTRANCE_BLOCKED',{blockedAt:coveredGate[0]});
    else if (gate && !entries.length) result = fail('BUILD_ENTRANCE_BLOCKED',{blockedAt:entryCandidates[0]});
    else if (!work.length) result = fail('BUILD_WORK_BLOCKED',{blockedAt:workCandidates[0]});
    else {
      const routeEntry = gate && connected(entries);
      const workPoint = connected(work);
      if (gate && !routeEntry) result = fail('BUILD_PATH_BLOCKED',{unreachableAt:entries[0]});
      else if (!workPoint) result = fail('BUILD_PATH_BLOCKED',{unreachableAt:work[0]});
      else result = { ...ok, entries, entryPoint:routeEntry || null, work, workPoint };
    }
    map.results.set(key,result);
  }
  if (!result.ok || !from) return result;
  const targets = entrance ? result.entries : result.work;
  const standAt = entrance ? result.entryPoint : result.workPoint;
  const code = entrance ? 'BUILD_ENTRANCE_BLOCKED' : 'BUILD_WORK_BLOCKED';
  if (!allows(...from)) return fail(code,{standAt,blockedAt:from});
  let blockedAt, nearest=Infinity;
  for (const [x,z] of targets) {
    const dx=x-from[0], dz=z-from[1], distance=Math.hypot(dx,dz);
    if (distance>1.85) continue;
    const steps=Math.max(1,Math.ceil(distance*12));
    let obstacle;
    for (let i=1;i<=steps;i++) {
      const point=[from[0]+dx*i/steps,from[1]+dz*i/steps];
      if (!allows(...point)) { obstacle=point; break; }
    }
    if (!obstacle) return result;
    if (distance<nearest) { blockedAt=obstacle; nearest=distance; }
  }
  return fail(code,blockedAt?{standAt,blockedAt}:{standAt});
}

export function recordConstructionBlock(w, actor, loc, action, reason) {
  if (!Object.hasOwn(CONSTRUCTION_CODES,reason)) return;
  const room = typeof loc==='string' && Object.hasOwn(w.locs,loc) ? loc : undefined;
  recordSettlementEvent(w,'construction_access',{actor,loc:room,action,reason});
}

export function constructionDestination(w, loc) {
  if (!constructionAccessEnabled(w)) return null;
  const s = w.survival;
  if (s.households?.projects[loc] || s.households?.deeds[loc]) return siteRecord(w,loc,'house');
  const site = s.sites.find(b=>b.loc===loc);
  if (site) return siteRecord(w,loc,site.type,site.lot);
  const task = s.coop?.task;
  return task?.loc===loc && !task.repair ? siteRecord(w,loc,task.type) : null;
}

export function residentConstructionAccess(w, id, record) {
  if (!constructionAccessEnabled(w)) return ok;
  const site = constructionAccess(w,record);
  if (!site.ok || w.loc[id]===record.loc) return site;
  const map = mapFor(w);
  const source = w.loc[id];
  const arrival = w.residentTravel?.[id];
  const from = (arrival?.to===source ? arrival.at : null) ?? w.districts?.[source]?.at ??
    w.peripheralHomes?.[source] ?? campSite(source,w.campLayout);
  const key = JSON.stringify(['travel',source,from,record]);
  if (map.results.has(key)) return map.results.get(key);
  const gate = campEntrance(source,w.peripheralHomes?.[source] ?? campSite(source,w.campLayout),w.peripheralHomes);
  const finishedHome = record.type==='house' && w.survival.households?.deeds[record.loc];
  const destination = finishedHome ? site.entryPoint : site.workPoint;
  const lots = map.records.map(b=>b.lot).concat(record.lot);
  const allows = (x,z) => groundQuery(w)(x,z) &&
    clearOfLots(lots,x,z) && clearOfLots(map.solids,x,z);
  const starts = [from,...(gate ? entrancePoints(gate) : [])].filter(p=>p && allows(...p));
  // A logical indoor location has no outdoor foot position; its exit is the start of the route.
  let result = fail('BUILD_PATH_BLOCKED');
  for (const point of starts) {
    // 居民施工行程都在营地/外围一圈，60 格窗口足够；320 格窗口是玩家出村远行的口径，
    // 放在每个居民到点上会扫数十万格（实测单刻阻塞 700ms+）。
    const route = joinedRoute(point,destination,allows,{margins:[14,60]});
    if (!route) continue;
    let length=0, prev=point;
    for (const next of route) { length+=Math.hypot(next[0]-prev[0],next[1]-prev[1]); prev=next; }
    result = { ...site, distance:length, destination, route };
    break;
  }
  map.results.set(key,result);
  return result;
}

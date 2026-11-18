import { campEntrance, campSite } from '../shared/camp-interaction.mjs';
import { campBridgeBounds, TOWN_SIZE, overlapsLot } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { districtPads } from '../shared/camp-districts.mjs';
import { outdoorStage, timberStage } from '../shared/camp-scene.mjs';
import { recordSettlementEvent } from './settlement-events.mjs';
import { inCamp, wildLandscape } from '../shared/wild-landscape.mjs';
import { joinedRoute } from '../shared/camp-outskirts.mjs';
import { constructionFootprint, constructionGate, entrancePoints, workPoints, clearOfLots, CONSTRUCTION_CODES } from '../shared/camp-construction-access.mjs';

const cache = new WeakMap();
const ok = { ok:true, code:'OK' };
const fail = code => ({ ok:false, code });

export const constructionAccessEnabled = w => w.gameRules === true && w.layoutVersion >= 2 && Boolean(w.campLayout);

export function siteRecord(w, loc, type, lot = constructionFootprint(loc,w.campLayout,w.districts,w.peripheralHomes,type)) {
  return {loc,type,lot};
}

function mapFor(w) {
  const layout = w.campLayout;
  const s = w.survival;
  let map = cache.get(w);
  if (!map || map.layout !== layout || map.districts !== w.districts) {
    const landmarks = Object.fromEntries(['home','hall','store','yard','workshop','garden','watch','well']
      .map(loc => [loc,campSite(loc,layout)]));
    const {riverCenter,riverHalfWidth} = campTerrain(w.mapSeed,true,w.layoutVersion);
    const bridge = campBridgeBounds(layout.crossZ-1, layout.crossZ+1, riverCenter, riverHalfWidth);
    const stage = outdoorStage({tw:TOWN_SIZE.width,th:TOWN_SIZE.depth,sites:landmarks,trees:[],grass:[],layoutSeed:w.mapSeed},[bridge],[]);
    const [x,z,X,Z] = bridge;
    const ground = (px,pz) => px>=x && px<=X && pz>=z && pz<=Z ||
      Math.abs(px-riverCenter(pz*16)/16) > riverHalfWidth(pz*16)/16;
    const pads = districtPads(w.districts);
    const terrain = wildLandscape(w.mapSeed,w.layoutVersion,{joined:true,flats:pads,clearing:pads});
    const anchor = [landmarks.hall[0]+.5,landmarks.hall[1]+2.7];
    map = { layout,districts:w.districts,anchor,ground,terrain,
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

export function constructionAccess(w, record, { proposed = false, from, entrance = false } = {}) {
  if (!constructionAccessEnabled(w)) return ok;
  if (!record.lot) return fail('NO_LOT');
  const map = mapFor(w);
  const others = map.records.filter(b=>b.loc!==record.loc || b.type!==record.type);
  const fixed = map.solids;
  const occupied = others.map(b=>b.lot);
  const ground = (x,z) => inCamp(x,z) ? map.ground(x,z) : map.terrain.walkable(x,z,w.campLayout.crossZ);
  const clearOutside = (x,z) => ground(x,z) && clearOfLots(fixed,x,z) && clearOfLots(occupied,x,z);
  const allows = (x,z) => clearOutside(x,z) && clearOfLots([record.lot],x,z);
  const key = JSON.stringify([record,proposed]);
  let result = map.results.get(key);
  if (!result) {
    const {x,z,w:width,d} = record.lot;
    const footprint = [[x,z],[x+width,z],[x,z+d],[x+width,z+d],[x+width/2,z+d/2]];
    const gate = constructionGate(record,w.campLayout,w.peripheralHomes);
    const entries = gate ? entrancePoints(gate).filter(p=>allows(...p)) : [];
    const work = workPoints(record.lot).filter(p=>allows(...p));
    const connected = points => points.find(p=>joinedRoute(p,map.anchor,allows));
    if (proposed && others.some(b=>overlapsLot(record.lot,b.lot,.35))) result = fail('OCCUPIED');
    else if (proposed && footprint.some(p=>!ground(...p))) result = fail('BUILD_PATH_BLOCKED');
    else if (proposed && [...map.entries,...others.map(other=>constructionGate(other,w.campLayout,w.peripheralHomes))].some(gate => {
      if (!gate || !overlapsLot(gate,record.lot,.33)) return false;
      const before = entrancePoints(gate).filter(p=>clearOutside(...p));
      return before.length && !before.some(p=>allows(...p));
    })) result = fail('BUILD_ENTRANCE_BLOCKED');
    else if (gate && !entries.length) result = fail('BUILD_ENTRANCE_BLOCKED');
    else if (!work.length) result = fail('BUILD_WORK_BLOCKED');
    else {
      const routeEntry = gate && connected(entries);
      const workPoint = connected(work);
      result = gate && !routeEntry || !workPoint ? fail('BUILD_PATH_BLOCKED') : { ...ok, entries, entryPoint:routeEntry || null, work, workPoint };
    }
    map.results.set(key,result);
  }
  if (!result.ok || !from) return result;
  const targets = entrance ? result.entries : result.work;
  if (!allows(...from)) return fail(entrance ? 'BUILD_ENTRANCE_BLOCKED' : 'BUILD_WORK_BLOCKED');
  const canReach = targets.some(([x,z])=>{
    const dx=x-from[0], dz=z-from[1], distance=Math.hypot(dx,dz);
    if (distance>1.85) return false;
    const steps=Math.max(1,Math.ceil(distance*12));
    for (let i=1;i<=steps;i++) {
      if (!allows(from[0]+dx*i/steps,from[1]+dz*i/steps)) return false;
    }
    return true;
  });
  return canReach ? result : fail(entrance ? 'BUILD_ENTRANCE_BLOCKED' : 'BUILD_WORK_BLOCKED');
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
  const allows = (x,z) => (inCamp(x,z)?map.ground(x,z):map.terrain.walkable(x,z,w.campLayout.crossZ)) &&
    clearOfLots(lots,x,z) && clearOfLots(map.solids,x,z);
  const starts = [from,...(gate ? entrancePoints(gate) : [])].filter(p=>p && allows(...p));
  // A logical indoor location has no outdoor foot position; its exit is the start of the route.
  let result = fail('BUILD_PATH_BLOCKED');
  for (const point of starts) {
    const route = joinedRoute(point,destination,allows);
    if (!route) continue;
    let length=0, prev=point;
    for (const next of route) { length+=Math.hypot(next[0]-prev[0],next[1]-prev[1]); prev=next; }
    result = { ...site, distance:length, destination, route };
    break;
  }
  map.results.set(key,result);
  return result;
}

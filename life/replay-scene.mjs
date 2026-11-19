// The render snapshot is separate from the action log and research/mind stores.
const mapFields=['mapSeed','layoutVersion','layout','districts','buildingsDef','settlementLife','farmLife'];
const sceneFields=[
  't','dayTicks','day','dayInSeason','phase','season','weather','disasterToday','drought','water',
  'rooms','outdoor','loc','occupancy','constructionArrivals','playerPos','peripheralHomes','districtTravel',
  'store','storeCap','resStock','plots','sites','buildings','housing','homeRoads','light',
  'campPlayerRoom','produce','livestock','wildBerries','berryPatches','ecoSources','regionHarvest',
];
const select=(source,fields)=>Object.fromEntries(fields.filter(field=>Object.hasOwn(source,field))
  .map(field=>[field,source[field]]));

export function replayTerrain(view) {
  return structuredClone(select(view,mapFields));
}

export function replayScene(view,side) {
  const scene={...select(view,sceneFields),compareSide:side,agents:Object.fromEntries(Object.entries(view.agents)
    .map(([id,a])=>[id,select(a,['id','name','isPlayer','stage','sex','injury','act','loc','dead'])]))};
  if (view.camp) scene.camp=select(view.camp,['timber','containers']);
  if (view.households) scene.households=select(view.households,['deeds','projects']);
  const impact=view.settlementEvents?.findLast(e=>e.kind==='storm_impact' && e.stormDay===view.day);
  if (impact) scene.settlementEvents=[impact];
  return structuredClone(scene);
}

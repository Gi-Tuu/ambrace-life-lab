import { constructionLot } from './camp-layout.mjs';

export const FACILITY_NAMES = Object.freeze({granary:'储粮设施',shelter:'避难住所',workshop:'生产工坊',wall:'防护墙'});
export const facilityId = b => 'facility:'+b.loc+':'+b.type;
export function facilityOf(world,id) {
  const buildings=world.buildings??world.survival?.buildings??[];
  return buildings.find(b=>facilityId(b)===id);
}
export function facilityGate(b,layout) {
  const lot=b.lot??constructionLot(b.loc,layout);
  if (!lot) return null;
  const {x,z,w,d}=lot;
  return {x:x+w/2-.8,z:z+d+.14,w:1.6,d:b.type==='granary'?1.48:1.08};
}
export const FACILITY_PROPS = Object.freeze({
  granary:[['grain',76,64],['grain',147,63]],
  shelter:[['bed',65,64],['hearth',148,61],['bench',153,113]],
  workshop:[['workbench',72,65],['shelf',151,59],['anvil',152,109]],
});

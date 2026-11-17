import { campSite, campEntrance } from './camp-interaction.mjs';
import { constructionLot, homeLot } from './camp-layout.mjs';
import { facilityGate } from './camp-facility.mjs';
import { CAMP_BODY_RADIUS } from './camp-3d-physics.mjs';

export const CONSTRUCTION_REACH = 1.15;
export const CONSTRUCTION_CODES = Object.freeze({
  BUILD_ENTRANCE_BLOCKED: '建筑入口被挡住',
  BUILD_WORK_BLOCKED: '工地周围没有可站立的施工位置',
  BUILD_PATH_BLOCKED: '通往入口或施工位置的路被挡住',
  BUILD_NOT_ARRIVED: '还没到达施工位置',
});

export function constructionFootprint(loc, layout, districts, homes, type) {
  return type === 'house' ? homeLot(loc, layout, homes) : districts?.[loc]?.lot ?? constructionLot(loc, layout);
}

export function constructionGate({loc,type,lot}, layout, homes) {
  if (type === 'wall') return null;
  if (type === 'house') return campEntrance(loc, homes?.[loc] ?? campSite(loc, layout), homes);
  return facilityGate({loc,type,lot}, layout);
}

export function entrancePoints({x,z,w,d}) {
  return [0, -.24, .24].map(offset => [x+w*(.5+offset), z+d*.65]);
}

export function workPoints({x,z,w,d}) {
  const pad = CAMP_BODY_RADIUS + .04;
  return [.5, .18, .82].flatMap(f => [
    [x+w*f,z+d+pad], [x-pad,z+d*f], [x+w+pad,z+d*f], [x+w*f,z-pad],
  ]);
}

export function clearOfLots(lots, x, z, radius = CAMP_BODY_RADIUS) {
  return lots.every(lot => x+radius<=lot.x || x-radius>=lot.x+lot.w ||
    z+radius<=lot.z || z-radius>=lot.z+lot.d);
}

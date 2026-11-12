export const RESIDENT_REACH = 1.6;
export const HEAVY_CAMP_TOOLS = Object.freeze(['axe','pick','hoe','hammer']);

export function nearResident(from,to) {
  return Array.isArray(from) && from.length===2 && from.every(Number.isFinite) &&
    Array.isArray(to) && to.length===2 && to.every(Number.isFinite) &&
    Math.hypot(from[0]-to[0],from[1]-to[1])<=RESIDENT_REACH;
}

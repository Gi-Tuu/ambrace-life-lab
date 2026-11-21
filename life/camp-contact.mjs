// 玩家→居民接触校验：从 camp-play 抽出，供 camp-play 与 resident-dialogue（自由对话两阶段）
// 共用同一套距离/房间/旅行判据，避免两条路各写一份闸门而漂移。
import { isAlive } from './body.mjs';
import { nearResident, distanceTo, segmentGap } from '../shared/camp-interaction.mjs';
import { regionPoint } from '../shared/camp-region-entities.mjs';
import { worldSite } from './geometry.mjs';
import { roomContains } from './space.mjs';

const roomPoint = (p) => roomContains(p[0], p[1]);

// Browser positions describe the current presentation. Room membership and the
// resident's current/recent world destinations are checked against server state.
export function residentContact(world, { target, room, from, to }) {
  if (typeof target !== 'string' || target === 'p1' || !Object.hasOwn(world.agents, target)) return 'NO_RESIDENT';
  if (!isAlive(world.agents[target])) return 'RESIDENT_GONE';
  if (!nearResident(from, to)) return 'RESIDENT_OUT_OF_REACH';
  const site = world.loc[target];
  if (room !== null) {
    return !world.survival.districtTravel?.[target] && room === site && room === world.loc.p1 && roomPoint(from) && roomPoint(to)
      ? null : 'RESIDENT_OUT_OF_REACH';
  }
  if (!regionPoint(from) || !regionPoint(to) || world.campPlayerRoom) {
    return 'RESIDENT_OUT_OF_REACH';
  }
  const at = worldSite(world, site);
  if (!at) return 'RESIDENT_OUT_OF_REACH';
  const destination = at.map((n) => n + .5);
  if (distanceTo(to, destination) <= 2.5) return null; // outdoor slots surround the logical anchor
  const trip = world.survival.districtTravel?.[target];
  const end = trip && worldSite(world, trip.to);
  if (end && segmentGap(to, destination, end.map((n) => n + .5)) <= 14) return null;
  const travel = world.residentTravel?.[target], start = worldSite(world, travel?.from);
  if (start && travel.to === site && world.t - travel.t <= 4 && segmentGap(to, start.map((n) => n + .5), destination) <= 6) return null;
  return 'RESIDENT_OUT_OF_REACH';
}

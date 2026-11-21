// 营地动作共享目录：survplay 的兼容时间表与 rules.validateCamp 共用，避免双表漂移。
export const PLAYER_TIME = Object.freeze({
  move: 25, gather: 75, harvest: 75, plant: 75, plan: 75, build: 75, repair: 75,
  forage: 75, exchange: 50, expand: 75, deposit: 50, withdraw: 50,
  animal_feed:25, animal_slaughter:75, road_lay:75, road_remove:50, home_request: 10, home_break: 75, home_fix: 60, home_grant: 10, home_revoke: 10, facility_use: 50,
  camp_chop: 75, camp_collect: 75, camp_plant: 75, camp_water: 50, camp_craft: 50,
  camp_store: 25, camp_take: 25, camp_eat: 50, camp_resident: 75, coop_request: 25, till: 75,
  camp_rest: 30,
});
export const CAMP_FREE = Object.freeze(['camp_exit', 'camp_sleep', 'camp_talk', 'camp_talk_say', 'camp_talk_close']);
export const isCampKind = (kind) => typeof kind === 'string' && kind.startsWith('camp_');

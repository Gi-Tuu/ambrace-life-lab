// V7.3 第二批：玩家与居民共用的动作时间/体力表（纯数据 + 旧名映射）。
// 只在正式游戏（actTimeModel）被玩家侧使用；研究态仍走旧的每刻 100 点预算，不引用本表。

export const SHARED_COST = Object.freeze({
  move: { minutes: 5, energy: 0 },
  gather: { minutes: 10, energy: 0.03 },
  forage: { minutes: 5, energy: 0.03 },
  harvest: { minutes: 10, energy: 0.05 },
  plant: { minutes: 10, energy: 0.04 },
  water: { minutes: 10, energy: 0.03 },
  till: { minutes: 30, energy: 0.10 },
  build: { minutes: 30, energy: 0.10 },
  repair: { minutes: 30, energy: 0.06 },
  plan: { minutes: 10, energy: 0.02 },
  eat: { minutes: 15, energy: 0 },
  store: { minutes: 5, energy: 0.01 },
  take: { minutes: 5, energy: 0.01 },
  talk: { minutes: 5, energy: 0.01 },
  exchange: { minutes: 5, energy: 0.01 },
  expand: { minutes: 30, energy: 0.12 },
  road: { minutes: 10, energy: 0.02 },
  home: { minutes: 10, energy: 0.02 },
  facility: { minutes: 15, energy: 0.02 },
  feed: { minutes: 10, energy: 0.02 },
  slaughter: { minutes: 30, energy: 0.08 },
  rest: { minutes: 0, energy: 0 },
  sleep: { minutes: 0, energy: 0 },
  free: { minutes: 0, energy: 0 },
});

// 玩家旧 kind → 共享动作。默认 5 分钟/0 体力（社交、请求等轻动作）。
export const PLAYER_TO_SHARED = Object.freeze({
  move: 'move', gather: 'gather', forage: 'forage', harvest: 'harvest', plant: 'plant',
  till: 'till', build: 'build', repair: 'repair', plan: 'plan', exchange: 'exchange', expand: 'expand',
  deposit: 'store', withdraw: 'take',
  animal_feed: 'feed', animal_slaughter: 'slaughter',
  road_lay: 'road', road_remove: 'road',
  home_request: 'home', home_grant: 'home', home_revoke: 'home', home_break: 'repair', home_fix: 'repair',
  facility_use: 'facility', coop_request: 'home',
  camp_chop: 'gather', camp_plant: 'plant', camp_water: 'water', camp_craft: 'build',
  camp_store: 'store', camp_take: 'take', camp_eat: 'eat', camp_resident: 'talk',
  camp_sleep: 'sleep', camp_exit: 'free',
});

function sharedKind(kind, body = {}) {
  if (kind === 'camp_collect') {
    if (body.type === 'crop') return 'harvest';
    if (body.type === 'berry') return 'forage';
    if (body.type === 'wood' || body.type === 'stone') return 'gather';
    return 'harvest';
  }
  if (kind.startsWith('talk_')) return 'talk';
  if (kind.startsWith('family_')) return 'free';
  if (kind === 'rest') return 'rest';
  if (kind === 'sleep') return 'sleep';
  return PLAYER_TO_SHARED[kind] ?? 'free';
}

// 玩家旧 kind（+ 可选 body 区分 camp_collect 品类）→ 共享动作、分钟、体力。
export function costFor(kind, body = {}) {
  const shared = sharedKind(kind, body);
  const base = SHARED_COST[shared] ?? SHARED_COST.free;
  return { shared, minutes: base.minutes, energy: base.energy };
}

export const ACTION_KINDS = Object.freeze(Object.keys(SHARED_COST));

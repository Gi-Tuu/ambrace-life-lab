// 1.6 C：体力恢复的唯一数值口径（纯模块）。
//
// 背景（实测）：正式世界体力只掉不涨——睡觉只推进时间，`camp_sleep` 不碰
// drives.v.energy；玩家能看到的恢复只有“吃一份 +0.5”和“shelter rest +0.15/刻”，
// 所以睡觉回来反而更累。这里把四条来源写死成一张表，HUD / 规则层 / 测试同源：
//   · 睡眠：每个完整游戏小时 +0.15，单次上限 0.9（能量本身仍封顶 1）；
//   · 通用休息：30 游戏分 +0.06，同一游戏小时 1 次，每游戏日 0.24；
//   · 棚下休息：沿用旧设施 +0.15/刻（survplay-camp 的 shelter 分支），值在这里声明；
//   · 吃饭：沿用 survival.feedReward（默认 0.5），不重复实现。
//
// 约束：
//   · 幽魂 / 忙碌 / compare / 研究态不进入本模块（调用方先过各自闸门）；
//   · 睡眠按“实际推进的小时”结算，死亡中断不补；
//   · 休息状态懒建在 survival.restRecovery，未休息过的旧档/研究态 dumpSurv 形状不变。

import { dayOf } from './clock.mjs';
import { simMinuteNow } from './sim-clock.mjs';

export const SLEEP_RECOVERY_PER_HOUR = 0.15;
export const SLEEP_RECOVERY_CAP = 0.9;
export const CAMP_REST_MINUTES = 30;
export const CAMP_REST_AMOUNT = 0.06;
export const CAMP_REST_DAILY_CAP = 0.24;
export const CAMP_REST_COOLDOWN_MIN = 60;
export const ENERGY_FULL_AT = 0.98;
export const SHELTER_REST_AMOUNT = 0.15;
export const ENERGY_RULES_TEXT = '睡觉 +0.15/游戏时（单次上限 0.9）· 休息 30 分 +0.06（每时 1 次 / 每日 0.24）· 棚下休息 +0.15/刻 · 吃饭 +0.5';

const round4 = (v) => Number(Number(v).toFixed(4));
const minuteOf = (world) => world?.simClock ? simMinuteNow(world) : (world?.t ?? 0) * 60;

export function sleepRecoveryFor(hours) {
  const h = Number.isFinite(hours) ? Math.max(0, hours) : 0;
  return round4(Math.min(SLEEP_RECOVERY_CAP, h * SLEEP_RECOVERY_PER_HOUR));
}

// 只写 p1.drives.v.energy；不做时间推进（时间由 host 的 sleep 循环/compare 的 tick 负责）。
export function applySleepRecovery(world, hours) {
  const a = world?.agents?.p1;
  if (!a?.drives?.v) return { gain: 0, before: null, after: null, hours: 0 };
  const before = a.drives.v.energy;
  const target = sleepRecoveryFor(hours);
  a.drives.reward('energy', target);
  const after = a.drives.v.energy;
  return { gain: round4(after - before), before: round4(before), after: round4(after), hours: Math.max(0, Number(hours) || 0) };
}

const REST_SITES = Object.freeze(['home', 'hall', 'yard', 'garden', 'workshop', 'well', 'watch']);
const fail = (code, why) => ({ ok: false, code, why });

// 位置：家（室内/家里）、连廊长凳、院子/菜园/工坊/井台/瞭望台的棚下。
function restSite(world) {
  const here = world?.campPlayerRoom ?? world?.loc?.p1;
  if (here === 'home' || world?.housing?.p1 === here) return 'home';
  return REST_SITES.includes(here) ? here : null;
}

export function campRestRule(world, { nowMin = null } = {}) {
  if (!world?.survival || !world?.agents?.p1) return fail('NOT_AVAILABLE');
  if (world.survival.playerDead === true || world.agents.p1.dead) return fail('PLAYER_DEAD');
  // 正式游玩才给这条动作；研究态/旧抽象预算不出现新恢复来源。
  if (world.independentWorld !== true && world.survival.actTimeModel !== true) return fail('NOT_AVAILABLE');
  const site = restSite(world);
  if (!site) return fail('NOT_AT_REST_SPOT');
  const a = world.agents.p1;
  if ((a.drives?.v?.energy ?? 1) >= ENERGY_FULL_AT) return fail('ENERGY_FULL');
  const minute = Number.isFinite(nowMin) ? nowMin : minuteOf(world);
  if (world.compareSide) return fail('REST_UNSUPPORTED');
  const day = dayOf(world.t ?? Math.floor(minute / 60));
  const hour = Math.floor(minute / 60);
  const s = world.survival;
  const st = s.restRecovery ??= { day, gain: 0, hour: -1, lastMin: -Infinity, count: 0 };
  if (st.day !== day) { st.day = day; st.gain = 0; st.hour = -1; }
  if (st.hour === hour) return fail('REST_COOLDOWN', '这一小时已经歇过了');
  if (Number.isFinite(st.lastMin) && minute - st.lastMin < CAMP_REST_COOLDOWN_MIN) return fail('REST_COOLDOWN', '刚歇过，过一会儿再坐');
  if (st.gain + CAMP_REST_AMOUNT > CAMP_REST_DAILY_CAP + 1e-9) return fail('REST_LIMIT', '今天已经歇够了');
  st.lastMin = minute;
  st.hour = hour;
  st.count = (st.count ?? 0) + 1;
  st.gain = round4(st.gain + CAMP_REST_AMOUNT);
  a.drives.reward('energy', CAMP_REST_AMOUNT);
  return { ok: true, code: 'OK', gain: CAMP_REST_AMOUNT, site, energy: round4(a.drives.v.energy), dayGain: st.gain };
}

// HUD/测试用：这一休息点此刻还能不能歇，以及为什么。
export function campRestState(world) {
  const site = restSite(world);
  const st = world?.survival?.restRecovery;
  return {
    site,
    allowed: Boolean(site),
    energyFull: (world?.agents?.p1?.drives?.v?.energy ?? 1) >= ENERGY_FULL_AT,
    day: st?.day ?? null,
    dayGain: st?.gain ?? 0,
    lastMin: Number.isFinite(st?.lastMin) ? st.lastMin : null,
    dailyCap: CAMP_REST_DAILY_CAP,
  };
}

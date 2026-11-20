// 1.1 第 2 项：正式连续世界的分钟级身体 micro-step。
//
// 口径：
//   · 唯一时间来源仍是 world.simClock（不另起时钟）；本模块只把 1 游戏分钟换算成
//     “旧刻”的 1/60，保持 PARAMS/NEED_META 的每小时标定不变。
//   · 只有真正会死人的身体量按分钟积分：能量、存续（v/reserve/侵蚀）、饥饿附加衰减、
//     天气/老年额外消耗、刺激调节。
//   · 社交需求与 M4 耦合的 τ 是“按刻”标定的（60 游戏分），仍在整点步进一次，保持旧量纲；
//     调制 bank 仍留在每刻首个 think 里 step(1)（RNG 抽取位置/次数不变）。
//   · 研究态没有 simClock ⇒ minuteMetab 不成立，本模块不被调用，旧逐位基线不变。
import { NEED_META } from './drives.mjs';
import { residentStage } from './households.mjs';

export const MINUTE_STEP = 1 / 60; // 一个游戏分钟 = 1/60 旧刻
export const ELDER_DECAY_PER_HOUR = 0.0004; // 与 survplay 旧 ELDER_DECAY 同值

export function bodyClockEnabled(world) {
  return Boolean(world?.simClock) && world.minuteMetab !== false;
}

// 旧 worldTick 里每刻一次的角色化/公仓饥饿附加（单位：刻/小时）。
// 只影响能量；社交部分在整点 hour 步里用同一 extra 复现旧式。
function hungerExtra(world, a, population) {
  const s = world.survival ?? {};
  let extra = 0;
  if (s.roleFarmer && a.id === s.farmerId) extra += 3;
  else if (s.allHunger) extra += 1;
  if (s.storeHunger === true) {
    const popH = Math.max(1, Number.isFinite(population) ? population : 1);
    const mult = 1 + (s.hungerK ?? 1) * Math.max(0, 1 - s.store / (popH * 3));
    if (mult > 1) extra += mult - 1;
  }
  return extra;
}

// 每个游戏分钟调用一次；不消费 RNG。
export function stepBodyMinute(world, a, { atMin, population } = {}) {
  if (!a || a.dead || !a.drives || !a.viab) return;
  const s = world.survival ?? {};
  const ch = a.ch ?? {};
  const isPlayer = a.isPlayer === true;
  const here = world.loc?.[a.id];

  // 能量：按分钟线性衰减（社交/aloneTicks 留在整点步，见 stepBodyHour）。
  a.drives.tick(MINUTE_STEP, false, { energy: true, social: false });
  if (!isPlayer) {
    const extra = hungerExtra(world, a, population);
    if (extra > 0) a.drives.v.energy = Math.max(0, a.drives.v.energy - NEED_META.energy.decay * extra * MINUTE_STEP);
    // 旧 metabolize 的坏天气额外消耗（只对居民；玩家旧路径没有这一项）。
    if (world.weatherEnabled && world.weather && world.weather !== 'clear' && (world.outdoor ?? []).includes(here)) {
      a.drives.v.energy = Math.max(0, a.drives.v.energy - 0.0008 * MINUTE_STEP);
    }
  }
  // 老年额外体能下降（旧 worldTick 对居民与玩家同规则，每刻 0.0004）。
  if (s.households && residentStage(world, a.id) === 'elder') {
    a.viab.v = Math.max(0, a.viab.v - ELDER_DECAY_PER_HOUR * MINUTE_STEP);
  }
  const erosion = a.viab.tick(MINUTE_STEP);
  if (erosion) a.noteErosion(erosion, world.t);
  // 刺激是被调量：bank 值在整点 think 里更新，这里每分钟把当前读数写回需求。
  if (!isPlayer && ch.driveRegulation !== 0) {
    const effUtil = ch.util ? a.bank.m : { ...a.traits.baseline };
    a.drives.regulate(effUtil);
  }
  a.metabCount = (a.metabCount ?? 0) + 1; // 观测用：身体分钟步数，不入档
}

// 每个整点（分钟数 % 60 === 0）调用一次，保持“刻”量纲的旧语义：
//   · 社交需求/aloneTicks 的 dt 仍是 1 刻，角色化/公仓饥饿的社交部分仍是 extra 刻；
//   · M4 耦合 τ 仍按刻倒数（dt=1）。
export function stepBodyHour(world, a, { population } = {}) {
  if (!a || a.dead || !a.drives || !a.viab) return;
  const isPlayer = a.isPlayer === true;
  const s = world.survival ?? {};
  const here = world.loc?.[a.id];
  const contact = !isPlayer && (world.occupancy?.[here] ?? []).length > 1;
  // 顺序与旧 worldTick 一致：先结算角色化/公仓饥饿附加（dt=extra，hadContact=false），
  // 再结算基础社交步（dt=1，按本刻 contact 决定 aloneTicks 是否清零）。
  const extra = isPlayer ? 0 : hungerExtra(world, a, population);
  if (extra > 0) a.drives.tick(extra, false, { energy: false, social: true });
  a.drives.tick(1, contact, { energy: false, social: true });
  if (!isPlayer && a.ch?.coupling && world.simClock && world.independentWorld) a.coupling.tick(1);
}

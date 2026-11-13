// 生存世界状态（Phase A）。服务端权威的资源/生态循环：
//   土壤/水分/天气 → 植物生长 → 收获入仓 → 居民每日消耗 → 缺口产生存续压力 → 失败/目标。
// 只在 world.survival 存在时生效（preset=survival）；lab/town 无此字段 ⇒ 逐位不变。
// 低频推进：每游戏日一次（由 body.scanSecrets 在日界调用），不每帧跑。
import { dayOf, weatherFor, seasonOf } from './clock.mjs';
import { siteOf } from './geometry.mjs';
import { initProduction, effectiveMods, dailyWear, regenResources } from './production.mjs';
import { isAlive, livingResidents } from './viability.mjs';

export const SURV = Object.freeze({
  startStore: 6,          // 初始公共粮仓
  foodPerPersonDay: 1,    // 每人每日消耗
  plots: 4,               // 菜园地块数
  yieldPerPlot: 3,        // 每块成熟地收获入仓
  growPerDay: 0.34,       // 基础日生长（约 3 天成熟，受水/土/天气调制）
  storeCap: 24,
  starveDaysToFail: 3,    // 连续空仓天数达此值判失败
  targetDays: 10,         // 求生目标：活到第 N 天
  starvePressure: 0.12,   // 缺口时每人每日存续扣减系数
});

export function initSurvival(world) {
  const garden = siteOf('garden') ?? [31, 39];
  const s = {
    lastDay: -1,
    store: SURV.startStore,
    water: 0.6,
    soil: 0.8,
    plots: Array.from({ length: SURV.plots }, (_, i) => ({ id: i, at: [garden[0] + (i % 2), garden[1] + Math.floor(i / 2)], growth: i === 0 ? 1 : 0.2 })),
    starveDays: 0,
    failed: false,
    won: false,
    ended: false,
    endReason: null,
    births: 0,
    lastBirthDay: -99,
    history: [],
  };
  initProduction(s);
  return s;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const maturePlots = (s) => s.plots.filter((p) => p.growth >= 1);

// §11 灾害哈希：与 weatherFor 同族 xorshift，确定可复现。
function hash01(seed, n) {
  let x = ((seed >>> 0) * 2654435761 ^ ((n + 1) >>> 0) * 40503) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967296;
}
export function stormOn(day, lastStormDay, seed = 7) {
  return day >= 3 && hash01(seed, day * 7 + 1) > 0.96 && day - (lastStormDay ?? -99) >= 4; // §11 预登记备选档（8%→4%）；实测仍负 ⇒ disasters 默认关
}
// 明日灾害预警（R1/G3）：风暴可提前一天知道；寒潮＝明日 cold 且今日已 cold。
export function forecastDisasters(world) {
  const s = world.survival;
  const day = dayOf(world.t) + 1;
  const w = weatherFor(world.seed ?? 7, day); // 与 tickSurvPlay 同源：新开一局换 seed 后预警必须跟着换
  return {
    forecast: w,
    stormTomorrow: s.disasters === true && stormOn(day, s.lastStormDay, world.seed ?? 7),
    coldsnapTomorrow: s.disasters === true && w === 'cold' && (s.coldStreak ?? 0) >= 1,
  };
}

// 每日推进：生长→消耗→压力→胜负。返回当日摘要（供事件/日志）。
const PANTRY_FOOD = ['berry', 'fruit', 'crop', 'egg', 'milk'];
// 家里容器是公仓缺口的第一层缓冲（玩家与居民同享）：按容器键序确定性地吃掉食物。
function drainCampPantry(world, need) {
  const all = world.survival.campContainers ?? {};
  for (const key of Object.keys(all)) {
    const bag = all[key];
    for (const item of PANTRY_FOOD) {
      while (need > 0 && (bag?.[item] ?? 0) > 0) { bag[item] -= 1; need -= 1; }
    }
  }
  return need;
}

export function advanceSurvival(world) {
  const s = world.survival;
  if (!s) return null;
  const day = dayOf(world.t);
  if (day === s.lastDay) return null;
  s.lastDay = day;
  const mods = effectiveMods(world);
  dailyWear(world, mods);
  regenResources(world); // P0-3：资源随世界时间再生（含树木再生回补木料账）

  // 水分：雨补、晴耗；土壤：休闲分解回流（§11 R2：空畦额外养土，仅 eco 开）。
  const rain = world.weather === 'rain';
  const cold = world.weather === 'cold';
  s.clearStreak = rain || cold ? 0 : (s.clearStreak ?? 0) + 1;
  s.coldStreak = cold ? (s.coldStreak ?? 0) + 1 : 0;
  const thr = s.droughts === false ? 3 : (s.droughtThreshold ?? 3); // §13：droughts=0 复原阶段A（阈值3）；备选档经 droughtThreshold=2
  s.drought = s.clearStreak >= thr;
  const dis = s.disasters === true;
  s.water = clamp01(s.water + (rain ? (s.rainRefill ?? 0.25) : -0.08) - (dis && s.drought ? 0.06 : 0)); // §15.5 M2 雨补挂开关
  const empty = s.plots.filter((p) => p.growth === 0).length;
  s.soil = clamp01(s.soil + 0.05 + (s.eco === true ? 0.05 * empty : 0));
  const wf = 0.4 + 0.6 * s.water, sf = 0.4 + 0.6 * s.soil;
  const coldF = cold ? 0.5 : 1;
  const seasonGrow = [1.0, 1.15, 0.9, 0.6][seasonOf(day)]; // §15 P2-B 四季调制生长
  const droughtF = dis && s.drought ? 0.8 : 1;
  for (const p of s.plots) if (p.growth > 0 && p.growth < 1) p.growth = clamp01(p.growth + SURV.growPerDay * wf * sf * coldF * droughtF * seasonGrow);

  // §11 R4 灾害：风暴（预警领先 1 天、冷却 4 天、day≥3）；寒潮＝cold 连≥2 天。
  s.disasterToday = null;
  if (dis && day >= 3) {
    if (stormOn(day, s.lastStormDay, world.seed ?? 7)) {
      s.lastStormDay = day;
      s.disasterToday = 'storm';
      for (const b of s.buildings) b.integrity = Math.max(0, Number((b.integrity - 0.15 * (mods.shield ? 0.4 : 1)).toFixed(2))); // 备选档伤害 0.25→0.15
      const growing = s.plots.filter((p) => p.growth > 0 && p.growth < 1);
      if (growing.length) {
        const p = growing[Math.floor(hash01(world.seed ?? 7, day * 13 + 5) * growing.length)];
        p.growth = Math.max(0, Number((p.growth - 0.5).toFixed(2)));
      }
    } else if (s.coldStreak >= 2) s.disasterToday = 'coldsnap';
  }

  // 居民每日消耗公共粮仓（§11 裁决②：playerEats 开则玩家也占一份）。P0-1：死者不占配给。
  const pop = livingResidents(world).length;
  const eaters = pop + (s.playerEats === true && isAlive(world.agents.p1) ? 1 : 0);
  const need = eaters * SURV.foodPerPersonDay + (s.disasterToday === 'coldsnap' ? eaters : 0);
  const ended = (s.failed || s.ended) && s.endFreeze === true; // §15 P2-B：终局/失败后冻结；won 仅作里程碑不终局（无尽）
  let shortfall = 0;
  if (!ended) {
    if (s.store >= need) s.store -= need;
    else { shortfall = need - s.store; s.store = 0; }
  }

  // P0-2：家里容器里的食物是真缓冲——公仓缺口先用它抵，再饿人（玩家与居民同规则）。
  if (!ended && shortfall > 0) shortfall = drainCampPantry(world, shortfall);
  if (!ended && shortfall > 0) {
    s.starveDays += 1;
    for (const a of Object.values(world.agents)) {
      if (!a.viab || !isAlive(a)) continue; // P0-1：死者不再受饥饿压力
      a.hurtBy = '饥饿';
      a.viab.v = Math.max(0, a.viab.v - SURV.starvePressure * mods.pressureMul * shortfall);
    }
  } else if (!ended) {
    s.starveDays = 0;
    // §15 同权驱动同步：吃饱的一天给能量驱动回补；§16 E1 workFeeds 开时取消自动喂饱（改劳动换食）
    if (s.workFeeds !== true) for (const a of Object.values(world.agents)) {
      if (!a.drives || !isAlive(a)) continue; // P0-1：死者不再被喂饱
      a.hurtBy = null;
      a.drives.reward('energy', s.feedReward ?? 0.5); // §15.3 喂饱系数挂开关供平衡网格
    }
  }

  // §15 P2-B 无尽终局：存活集合中不存在异性对 ⇒ 无法繁衍＝必定灭绝（含只剩 1 人/同性对）；先于 failed 判定
  if (!s.ended) {
    const alive = Object.values(world.agents).filter(isAlive); // P0-1：死者不算存活集合
    const sexes = alive.map((a) => world.sex?.[a.id]);
    const hasPair = sexes.includes('M') && sexes.includes('F');
    if (!hasPair) { s.ended = true; s.endReason = alive.length <= 1 ? 'sole' : 'noPair'; }
  }
  const allDead = livingResidents(world).length === 0; // P0-1：存活居民为零＝聚落饿垮
  if (!s.ended && !s.failed && (s.starveDays >= SURV.starveDaysToFail || allDead)) s.failed = true;
  if (!s.failed && day >= SURV.targetDays) s.won = true; // 里程碑徽章（无尽模式不终局）

  const summary = { day, store: s.store, need, shortfall, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)), mature: maturePlots(s).length, failed: s.failed, won: s.won, drought: !!s.drought, disaster: s.disasterToday };
  s.history.push(summary);
  if (s.history.length > 60) s.history.shift();
  return summary;
}

// 行动效果（由 body.actuate 调用，统一走规则校验）。
export function doHarvest(world, agentId, plot) {
  const s = world.survival;
  const p = maturePlots(s).find(p=>plot===undefined || p.id===plot);
  if (!p) return { ok: false, code: 'NO_MATURE' };
  const mods = effectiveMods(world);
  p.growth = 0;
  const base = SURV.yieldPerPlot + mods.yieldBonus;
  const yieldAmt = s.eco === true ? Math.max(1, Math.round(base * (0.8 + 0.2 * s.soil))) : base; // §12 缓和曲线候选（0.5+0.5 被 G1 否）
  s.soil = clamp01(s.soil - 0.15);
  s.yieldTotal = (s.yieldTotal ?? 0) + yieldAmt;
  s.harvestCount = (s.harvestCount ?? 0) + 1;
  s.store = Math.min(mods.storeCap, s.store + yieldAmt);
  return { ok: true, code: 'OK', amount: yieldAmt };
}
export function doPlant(world, agentId, plot) {
  const s = world.survival;
  const p = s.plots.find(x=>x.growth===0 && (plot===undefined || x.id===plot));
  if (!p) return { ok: false, code: 'NO_EMPTY_PLOT' };
  if (s.water < (s.plantWater ?? 0.1)) return { ok: false, code: 'NO_WATER' };
  s.water = clamp01(s.water - (s.plantWater ?? 0.1)); // §15.5 M2 播种耗水挂开关
  p.growth = 0.1;
  return { ok: true, code: 'OK' };
}
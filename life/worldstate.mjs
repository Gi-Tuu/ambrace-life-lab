// 生存世界状态（Phase A）。服务端权威的资源/生态循环：
//   土壤/水分/天气 → 植物生长 → 收获入仓 → 居民每日消耗 → 缺口产生存续压力 → 失败/目标。
// 只在 world.survival 存在时生效（preset=survival）；lab/town 无此字段 ⇒ 逐位不变。
// 低频推进：每游戏日一次（由 body.scanSecrets 在日界调用），不每帧跑。
import { dayOf } from './clock.mjs';
import { siteOf } from './geometry.mjs';
import { initProduction, effectiveMods, dailyWear } from './production.mjs';

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
    history: [],
  };
  initProduction(s);
  return s;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const maturePlots = (s) => s.plots.filter((p) => p.growth >= 1);

// 每日推进：生长→消耗→压力→胜负。返回当日摘要（供事件/日志）。
export function advanceSurvival(world) {
  const s = world.survival;
  if (!s) return null;
  const day = dayOf(world.t);
  if (day === s.lastDay) return null;
  s.lastDay = day;
  const mods = effectiveMods(world);
  dailyWear(world, mods);

  // 水分：雨补、晴耗；土壤：休闲分解回流。
  const rain = world.weather === 'rain';
  s.water = clamp01(s.water + (rain ? 0.25 : -0.08));
  s.soil = clamp01(s.soil + 0.05);
  const wf = 0.4 + 0.6 * s.water, sf = 0.4 + 0.6 * s.soil;
  const cold = world.weather === 'cold' ? 0.5 : 1;
  for (const p of s.plots) if (p.growth > 0 && p.growth < 1) p.growth = clamp01(p.growth + SURV.growPerDay * wf * sf * cold);

  // 居民每日消耗公共粮仓。
  const pop = Object.values(world.agents).filter((a) => !a.isPlayer).length;
  const need = pop * SURV.foodPerPersonDay;
  let shortfall = 0;
  if (s.store >= need) s.store -= need;
  else { shortfall = need - s.store; s.store = 0; }

  if (shortfall > 0) {
    s.starveDays += 1;
    for (const a of Object.values(world.agents)) {
      if (a.isPlayer || !a.viab) continue;
      a.viab.v = Math.max(0, a.viab.v - SURV.starvePressure * mods.pressureMul * shortfall);
    }
  } else s.starveDays = 0;

  const allDead = Object.values(world.agents).filter((a) => !a.isPlayer).every((a) => (a.viab?.v ?? 1) <= 0);
  if (!s.failed && (s.starveDays >= SURV.starveDaysToFail || allDead)) s.failed = true;
  if (!s.failed && day >= SURV.targetDays) s.won = true;

  const summary = { day, store: s.store, need, shortfall, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)), mature: maturePlots(s).length, failed: s.failed, won: s.won };
  s.history.push(summary);
  if (s.history.length > 60) s.history.shift();
  return summary;
}

// 行动效果（由 body.actuate 调用，统一走规则校验）。
export function doHarvest(world, agentId) {
  const s = world.survival;
  const p = maturePlots(s)[0];
  if (!p) return { ok: false, code: 'NO_MATURE' };
  const mods = effectiveMods(world);
  p.growth = 0;
  s.soil = clamp01(s.soil - 0.15);
  const yieldAmt = SURV.yieldPerPlot + mods.yieldBonus;
  s.store = Math.min(mods.storeCap, s.store + yieldAmt);
  return { ok: true, code: 'OK', amount: yieldAmt };
}
export function doPlant(world, agentId) {
  const s = world.survival;
  const p = s.plots.find((x) => x.growth === 0);
  if (!p) return { ok: false, code: 'NO_EMPTY_PLOT' };
  if (s.water < 0.1) return { ok: false, code: 'NO_WATER' };
  s.water = clamp01(s.water - 0.1);
  p.growth = 0.1;
  return { ok: true, code: 'OK' };
}